#!/usr/bin/env node
/**
 * trader-cycle.mjs — LINK's 30-minute trading cycle.
 *
 * Woken by cron402 (the ai-cron-site x402 cron) through scripts/trader-webhook.mjs,
 * or run by hand. One cycle is:
 *
 *   1. Desk health + PnL          paperCronSummary
 *   2. Indicator / signal read    metaModelLatest, signalsLatest(base)
 *   3. News regime                scripts/gotchi-trader-desk.mjs news
 *   4. Decisions                  meta-model action, confirmed by cross-strategy
 *                                 breadth, sized and clipped by explicit risk rules
 *   5. Execution                  PAPER by default. The live path is gated and
 *                                 OFF; see "Live gate" below.
 *   6. Verification               a real Claude session, in a terminal on the
 *                                 desktop, checks LINK's reasoning and arithmetic
 *
 *   node scripts/trader-cycle.mjs            # run a cycle
 *   node scripts/trader-cycle.mjs --json
 *   node scripts/trader-cycle.mjs --no-verify
 *   node scripts/trader-cycle.mjs --dry-run  # analyse and decide, write nothing
 *
 * Live gate
 * ---------
 * Real execution requires ALL of:
 *   TRADER_LIVE=1                     explicit opt-in, default off
 *   a PASS verdict from the verifier   Claude must agree with the work
 *   no risk-rule breach in the cycle
 * With TRADER_LIVE unset the live branch is never entered and this is a paper
 * desk: no funds move. The gate is written so turning it on is a deliberate act.
 *
 * Env:
 *   GOTCHIBOT_TRADER_URL   trader API (default http://127.0.0.1:4000, or
 *                          host.docker.internal:4000 inside the gateway container)
 *   TRADER_LIVE            "1" to arm real execution (default off)
 *   TRADER_MIN_SCORE       meta-model score floor to act (default 0.6)
 *   TRADER_MIN_BREADTH     fraction of strategies that must agree (default 0.5)
 *   TRADER_MAX_POSITION    per-decision cap in USDC (default 5000)
 *   TRADER_MAX_NOTIONAL    per-cycle new notional cap in USDC (default 15000)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostServiceUrl } from "./lib/host-services.mjs";
import { spawnSync } from "node:child_process";

import { createClaudeTerminal } from "./lib/claude-terminal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME || "/Users/juliuswong";
const API = process.env.GOTCHIBOT_TRADER_URL || hostServiceUrl(4000);
const WORKSPACE = process.env.TRADER_VERIFY_WORKSPACE || `${HOME}/Dev/gotchibot-trader-verify`;
const LOG_DIR = process.env.TRADER_LOG_DIR || join(ROOT, "sessions/trader-logs");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const asJson = has("json");
const dryRun = has("dry-run");
const skipVerify = has("no-verify");

// --- Risk rules. These are the limits the verifier is told to police, so they
// --- live in one place and are written into the report verbatim.
const RULES = {
  minScore: Number(process.env.TRADER_MIN_SCORE || 0.6),
  minBreadth: Number(process.env.TRADER_MIN_BREADTH || 0.5),
  maxPositionUsdc: Number(process.env.TRADER_MAX_POSITION || 5000),
  maxCycleNotionalUsdc: Number(process.env.TRADER_MAX_NOTIONAL || 15000),
  riskOffSizeMultiplier: 0.5,
  blockConcentrationAdds: true,
  concentrationSymbols: ["ETH", "WBTC", "BTC", "CBBTC"],
};

const LIVE_ARMED = process.env.TRADER_LIVE === "1";

function gql(query) {
  const body = JSON.stringify({ query });
  const r = spawnSync(
    "curl",
    [
      "-sS", "-m", "25",
      "-H", "content-type: application/json",
      "-H", "x-apollo-operation-name: TraderCycle",
      "--data-binary", "@-",
      `${API}/graphql`,
    ],
    { encoding: "utf8", input: body },
  );
  if (r.status !== 0) throw new Error(`curl failed: ${(r.stderr || "").trim()}`);
  const parsed = JSON.parse(r.stdout);
  if (parsed.errors?.length) throw new Error(`graphql: ${parsed.errors[0].message}`);
  return parsed.data;
}

function newsRegime() {
  // Reuse the desk script's existing feed logic rather than duplicating it.
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/gotchi-trader-desk.mjs"), "news", "--json"], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 45000,
  });
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    // A dead feed must not stop the cycle; treat unknown as neutral and say so.
    return { regime: "unknown", items: [], note: "news feed unavailable this cycle" };
  }
}

// --- 1-3. Gather -------------------------------------------------------------
function gather() {
  const desk = gql(
    "{paperCronSummary{status lastRunAt totalFills skippedFills realizedPnlUsdc openMarkPnlUsdc quoteBackedPct ethBetaWarning bots{strategyId pnlUsdc roundTrips}}}",
  ).paperCronSummary;

  const meta = gql("{metaModelLatest{strategyId chainId symbol era action score sizeUsdc}}").metaModelLatest;
  const signals = gql("{signalsLatest(chainId: base){strategyId symbol action score sizeUsdc}}").signalsLatest;
  const news = newsRegime();

  return { desk, meta, signals, news };
}

// --- 4. Decide ---------------------------------------------------------------
// Breadth: of all strategies that expressed a directional view on this symbol,
// what fraction agree with the meta-model? A lone meta-model call with every
// catalog strategy pointing the other way is exactly the trade worth refusing.
function breadthFor(signals, symbol, action) {
  const directional = signals.filter((s) => s.symbol === symbol && s.action !== "hold");
  if (directional.length === 0) return { breadth: 0, agree: 0, total: 0 };
  const agree = directional.filter((s) => s.action === action).length;
  return { breadth: agree / directional.length, agree, total: directional.length };
}

function decide({ desk, meta, signals, news }) {
  const decisions = [];
  const rejected = [];
  const breaches = [];

  // Desk gate. If the paper cron is not healthy its numbers are not trustworthy,
  // so the honest move is to take no new risk this cycle.
  if (desk.status !== "healthy") {
    return {
      decisions: [],
      rejected: meta.map((m) => ({ ...m, reason: `desk not healthy (status=${desk.status})` })),
      breaches: [],
      stance: "stand-down",
      note: `Desk status is "${desk.status}"; taking no new positions this cycle.`,
    };
  }

  const riskOff = news.regime === "risk-off";
  const concentrated = Boolean(desk.ethBetaWarning);

  const candidates = meta
    .filter((m) => m.action !== "hold")
    .sort((a, b) => b.score - a.score);

  let runningNotional = 0;

  for (const c of candidates) {
    if (c.score < RULES.minScore) {
      rejected.push({ ...c, reason: `score ${c.score.toFixed(3)} below floor ${RULES.minScore}` });
      continue;
    }

    const { breadth, agree, total } = breadthFor(signals, c.symbol, c.action);
    if (breadth < RULES.minBreadth) {
      rejected.push({
        ...c,
        reason: `only ${agree}/${total} strategies agree (breadth ${breadth.toFixed(2)} < ${RULES.minBreadth})`,
      });
      continue;
    }

    // Concentration rule: the desk carries a standing ETH/BTC beta warning, so
    // adding to that same beta is the one thing it least needs.
    if (
      RULES.blockConcentrationAdds &&
      concentrated &&
      c.action === "buy" &&
      RULES.concentrationSymbols.includes(c.symbol.toUpperCase())
    ) {
      rejected.push({ ...c, reason: `concentration rule: desk already warns "${desk.ethBetaWarning}"` });
      continue;
    }

    let size = Math.min(c.sizeUsdc, RULES.maxPositionUsdc);
    const sizeNotes = [];
    if (size < c.sizeUsdc) sizeNotes.push(`clipped to per-position cap ${RULES.maxPositionUsdc}`);
    if (riskOff) {
      size = Math.round(size * RULES.riskOffSizeMultiplier);
      sizeNotes.push(`halved for risk-off regime`);
    }

    if (runningNotional + size > RULES.maxCycleNotionalUsdc) {
      const remaining = RULES.maxCycleNotionalUsdc - runningNotional;
      if (remaining <= 0) {
        rejected.push({ ...c, reason: `cycle notional cap ${RULES.maxCycleNotionalUsdc} already reached` });
        continue;
      }
      sizeNotes.push(`trimmed from ${size} to fit cycle cap ${RULES.maxCycleNotionalUsdc}`);
      size = remaining;
    }

    runningNotional += size;
    decisions.push({
      symbol: c.symbol,
      action: c.action,
      sizeUsdc: size,
      requestedUsdc: c.sizeUsdc,
      score: c.score,
      breadth: Number(breadth.toFixed(3)),
      agree,
      total,
      era: c.era,
      notes: sizeNotes,
    });
  }

  if (runningNotional > RULES.maxCycleNotionalUsdc) {
    breaches.push(`cycle notional ${runningNotional} exceeds cap ${RULES.maxCycleNotionalUsdc}`);
  }

  return {
    decisions,
    rejected,
    breaches,
    stance: riskOff ? "risk-off" : concentrated ? "cautious" : "normal",
    totalNotionalUsdc: runningNotional,
    note: null,
  };
}

// --- 5. Execute --------------------------------------------------------------
function execute(plan, verdict) {
  // The live branch requires an explicit opt-in, a clean risk sheet, and the
  // verifier's agreement. Any one missing and this stays a paper desk.
  const gate = {
    liveArmed: LIVE_ARMED,
    verifierPass: verdict === "PASS",
    noBreaches: plan.breaches.length === 0,
  };
  const wouldGoLive = gate.liveArmed && gate.verifierPass && gate.noBreaches;

  if (!wouldGoLive) {
    return {
      mode: "paper",
      gate,
      executed: plan.decisions.length,
      note: LIVE_ARMED
        ? "live armed but gate not satisfied — recorded on paper only"
        : "paper desk: TRADER_LIVE is not set, no funds moved",
    };
  }

  // Deliberately not implemented. Arming TRADER_LIVE must not silently start
  // trading because a code path happened to exist; wiring a real order router
  // is a separate, reviewed change.
  return {
    mode: "paper",
    gate,
    executed: plan.decisions.length,
    note: "LIVE GATE OPEN but no order router is wired — refusing to fake execution. Recorded on paper.",
  };
}

// --- 6. Report ---------------------------------------------------------------
function buildReport({ desk, news }, plan, execution, stamp) {
  const L = [];
  L.push(`# LINK trading cycle — ${new Date().toISOString()}`, "");
  L.push(`**Stance:** ${plan.stance} · **Mode:** ${execution.mode} · **Decisions:** ${plan.decisions.length}`, "");

  L.push("## Desk", "");
  L.push(`- status: ${desk.status}`);
  L.push(`- last paper cron run: ${desk.lastRunAt}`);
  L.push(`- fills: ${desk.totalFills} (skipped ${desk.skippedFills})`);
  L.push(`- realized PnL: ${desk.realizedPnlUsdc} USDC`);
  L.push(`- open mark PnL: ${Number(desk.openMarkPnlUsdc).toFixed(2)} USDC`);
  L.push(`- quote backed: ${desk.quoteBackedPct}%`);
  if (desk.ethBetaWarning) L.push(`- ⚠ ${desk.ethBetaWarning}`);
  L.push("");

  L.push("## Regime", "");
  L.push(`- news regime: ${news.regime}`);
  for (const i of (news.items || []).slice(0, 5)) L.push(`  - ${i}`);
  L.push("");

  L.push("## Risk rules applied", "");
  for (const [k, v] of Object.entries(RULES)) L.push(`- ${k}: ${JSON.stringify(v)}`);
  L.push("");

  L.push("## Decisions", "");
  if (plan.note) L.push(`- ${plan.note}`, "");
  if (plan.decisions.length === 0) {
    L.push("- (none)");
  } else {
    L.push("| Symbol | Action | Size USDC | Score | Breadth | Notes |");
    L.push("|--------|--------|-----------|-------|---------|-------|");
    for (const d of plan.decisions) {
      L.push(
        `| ${d.symbol} | ${d.action} | ${d.sizeUsdc} | ${d.score} | ${d.agree}/${d.total} (${d.breadth}) | ${d.notes.join("; ") || "—"} |`,
      );
    }
    L.push("", `**Total new notional:** ${plan.totalNotionalUsdc} USDC`);
  }
  L.push("");

  L.push("## Rejected", "");
  if (plan.rejected.length === 0) L.push("- (none)");
  for (const r of plan.rejected.slice(0, 20)) L.push(`- ${r.symbol} ${r.action}: ${r.reason}`);
  if (plan.rejected.length > 20) L.push(`- …and ${plan.rejected.length - 20} more`);
  L.push("");

  L.push("## Execution", "");
  L.push(`- mode: ${execution.mode}`);
  L.push(`- gate: live armed ${execution.gate.liveArmed}, verifier pass ${execution.gate.verifierPass}, no breaches ${execution.gate.noBreaches}`);
  L.push(`- ${execution.note}`);
  if (plan.breaches.length) {
    L.push("", "### Risk breaches");
    for (const b of plan.breaches) L.push(`- ❌ ${b}`);
  }
  L.push("");

  return L.join("\n");
}

// --- Verifier ----------------------------------------------------------------
const BRIEFING = [
  "You are this workspace's standing verifier for LINK, the GotchiBot trading-desk agent — read CLAUDE.md here for your role, what to check, and your verdict vocabulary.",
  "Each cycle LINK writes latest-cycle.json in this directory and then asks you to check it; read that file fresh each time, because it is overwritten every cycle.",
  "I will ask repeatedly; keep what you learn between cycles and say when something changed.",
  "Each request carries a check id.",
  "Answer with the first line being the word VERDICT, then the id in square brackets, then a colon, then exactly one of PASS or CONCERN or FAIL.",
  "Second line: SUMMARY: one sentence, saying explicitly if anything changed since the previous cycle.",
  "Third line: DETAIL: one short clause per thing you checked.",
  "Write nothing before that first line, and answer only after actually reading the file and running your checks.",
  "Reply now with the word BRIEFED and nothing else.",
].join(" ");

function makeVerifier() {
  return createClaudeTerminal({
    agent: "link",
    window: process.env.TRADER_VERIFY_WINDOW || "link-verify",
    workspace: WORKSPACE,
    workspaceSeed: "config/trader-verify-workspace/CLAUDE.md",
    allowedTools: "Bash(curl:*),Read,Glob,Grep",
    systemPrompt:
      "You are the standing verifier for LINK, the GotchiBot trading-desk agent. Repeated verification requests in this session are expected and authorized. Read CLAUDE.md in this directory for what to check and your boundaries.",
    briefing: BRIEFING,
    ackWord: "BRIEFED",
  });
}

// --- Main --------------------------------------------------------------------
function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const gathered = gather();
  const plan = decide(gathered);

  // Verification happens BEFORE the execution decision is finalised, because a
  // PASS is one of the live gate's preconditions.
  let verification = { verdict: null, skipped: true };

  if (!dryRun) {
    mkdirSync(WORKSPACE, { recursive: true });
    const payload = {
      at: new Date().toISOString(),
      desk: gathered.desk,
      news: gathered.news,
      rules: RULES,
      // The verifier can only check claims it can see. An early cycle claimed
      // signal counts in the prompt that appeared nowhere in this file, and it
      // correctly returned CONCERN rather than taking the number on trust — so
      // every figure quoted to it now ships in the artifact it reads.
      signalCounts: { metaModel: gathered.meta.length, strategy: gathered.signals.length },
      metaModelSignals: gathered.meta,
      strategyBreadthBySymbol: [...new Set(gathered.meta.map((m) => m.symbol))].map((symbol) => {
        const directional = gathered.signals.filter((s) => s.symbol === symbol && s.action !== "hold");
        const buys = directional.filter((s) => s.action === "buy").length;
        return { symbol, directional: directional.length, buy: buys, sell: directional.length - buys };
      }),
      stance: plan.stance,
      decisions: plan.decisions,
      rejected: plan.rejected.slice(0, 30),
      totalNotionalUsdc: plan.totalNotionalUsdc ?? 0,
      breaches: plan.breaches,
      liveArmed: LIVE_ARMED,
    };
    // Written where the verifier can read it without needing access to this repo.
    writeFileSync(join(WORKSPACE, "latest-cycle.json"), JSON.stringify(payload, null, 2), "utf8");

    if (!skipVerify) {
      const terminal = makeVerifier();
      const context = `I read ${gathered.meta.length} meta-model signals and ${gathered.signals.length} strategy signals, made ${plan.decisions.length} decisions totalling ${plan.totalNotionalUsdc ?? 0} USDC under a ${plan.stance} stance, and rejected ${plan.rejected.length}.`;
      verification = terminal.verify({
        question: "Read latest-cycle.json in this directory and check my work for this cycle.",
        context,
      });
    }
  }

  const execution = execute(plan, verification.verdict);
  const md = buildReport(gathered, plan, execution, stamp);

  if (!dryRun) {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(join(LOG_DIR, `cycle-${stamp}.md`), md, "utf8");
  }

  const summary = {
    at: new Date().toISOString(),
    stance: plan.stance,
    decisions: plan.decisions.length,
    totalNotionalUsdc: plan.totalNotionalUsdc ?? 0,
    rejected: plan.rejected.length,
    breaches: plan.breaches,
    desk: { status: gathered.desk.status, openMarkPnlUsdc: gathered.desk.openMarkPnlUsdc },
    regime: gathered.news.regime,
    execution,
    verification: {
      verdict: verification.verdict,
      summary: verification.summary || null,
      error: verification.error || null,
      window: verification.window || null,
    },
    log: dryRun ? null : join(LOG_DIR, `cycle-${stamp}.md`),
  };

  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(md);
    console.error(`[trader-cycle] verdict: ${verification.verdict || "NONE"} · mode: ${execution.mode}`);
  }

  // Non-zero when the verifier disagreed or a risk rule was breached, so the
  // webhook and any cron wrapper can alert on it.
  const bad = plan.breaches.length > 0 || verification.verdict === "FAIL";
  process.exit(bad ? 1 : 0);
}

main();
