#!/usr/bin/env node
/**
 * prof.link-cube — NPC professor in GotchiBot (not mintable, not a cAavegotchi seat).
 * He runs the summoning desk: summon (portal mint) or resummon (existing hero)
 * a profiled cAavegotchi. The professor himself is never minted or assigned a hero id.
 *
 * Portal language (Aavegotchi summoning). Legacy aliases: hatch → summon, rehatch → resummon.
 *
 * Flow: intake → design → confirm → summon(portal) OR resummon(existing)
 *       → wire agent-roles + playbooks + workspace files + fleet sync.
 *
 *   node scripts/prof-link-cube.mjs intake --job "financial analyst" --non-coding \
 *        --voice "even-keeled spirit" --anti-jobs "live trading; public posts" \
 *        --collateral link --mode resummon --hero starter-link-h1-1
 *   node scripts/prof-link-cube.mjs design [--dry-run]          # prints draft; never writes target configs
 *   node scripts/prof-link-cube.mjs confirm [--dry-run] [--yes] # applies; refuses without --yes / GOTCHIBOT_AUTO_APPROVE=1 / interactive y
 *   node scripts/prof-link-cube.mjs summon --confirmed [--auto-mint gotchi|wallet|none] [--yes]
 *        # prints portal mint plan, then prompts (or uses --auto-mint) to optionally
 *        # mint-sub a collateral gotchi OR ensure wallet+cartridge. Never mints the professor.
 *   node scripts/prof-link-cube.mjs resummon --hero <id> [--role <role>] [--standing-duty <key>] [--dry-run] [--yes] [--force] [--project <slug>]
 *   node scripts/prof-link-cube.mjs bind --hero <id> [--role <role>] [--standing-duty <key>] [--yes]
 *   node scripts/prof-link-cube.mjs status
 *
 * Safety rules (hard):
 *   - design NEVER writes target configs (agent-roles / playbooks / standing duties / workspaces).
 *   - confirm refuses without --yes, GOTCHIBOT_AUTO_APPROVE=1, or an interactive y.
 *   - summon refuses without a confirmed design AND --confirmed; default is plan-only.
 *     Auto-mint (gotchi|wallet) needs a second yes: interactive pick, or --auto-mint + --yes.
 *   - resummon never mints; it only rewires an existing hero (no wallet, no cartridge writes).
 *   - Prof. Link-Cube is an NPC — never minted, never assigned a hero id.
 *   - No installs, no secrets, no Blockscout, no token-id hunting.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {
  commandExists,
  ensureCartridgeForOwner,
  hasServiceKey,
  mintSubAgentHero,
  readWalletFile,
  runAbraNode,
} from "./onboarding-lib.mjs";
import { loadMeta } from "./identity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, "sessions", "link-cube");
const STATE_FILE = join(STATE_DIR, "state.json");
const ROLES_PATH = join(ROOT, "config", "agent-roles.json");
const PLAYBOOKS_PATH = join(ROOT, "config", "agent-role-playbooks.json");
const STANDING_PATH = join(ROOT, "config", "agent-standing-duties.json");
const FLEET_SYNC = join(ROOT, "scripts", "openclaw-fleet.mjs");

/** spirit ids for the 16 starter collaterals (cartridge mint-sub). */
const SPIRIT_IDS = {
  dai: "dai", weth: "weth", aave: "aave", link: "link", usdt: "usdt",
  usdc: "usdc", tusd: "tusd", uni: "uni", yfi: "yfi", wbtc: "wbtc",
  btc: "wbtc", matic: "matic",
};

/**
 * Composed standing duties, keyed for reuse. "trader-monitor" is the
 * Gotchi-Trader paper desk standing duty lifted from the trader-desk playbook
 * (skills, reportCmd, cycleCmd, scheduleCmd, decision table, risk rules, live
 * gate, schedule truth) — preserved verbatim so a resummon never drops it.
 */
const STANDING_DUTIES = {
  "trader-monitor": {
    label: "Standing duty — Gotchi-Trader monitor (kept from trader-desk)",
    skills: ["gotchi-trader-monitor", "gotchi-trader-improve", "market-news-feed"],
    reportCmd: "./scripts/gotchi-trader-desk.mjs status",
    cycleCmd: "./scripts/trader-cycle.mjs --json",
    scheduleCmd: "./scripts/gotchibot trader schedule status",
    window: "link-verify",
    driver: "trader-cycle.mjs",
    workspace: "~/Dev/gotchibot-trader-verify",
    seed: "config/trader-verify-workspace/CLAUDE.md",
    allowedTools: "Bash(curl:*),Read,Glob,Grep",
    markdown: `I still own the Gotchi-Trader **paper** desk as a standing duty: desk health, cycle decisions, PnL reporting.

| Asked, or event | I run exactly | I reply with |
|---|---|---|
| "status", "how's the desk", "PnL", "positions" | \`./scripts/gotchi-trader-desk.mjs status\` | the output verbatim, then one line of my read. Open mark is mark, not PnL. |
| "is your cycle scheduled?", "are you actually running every 30 minutes?" | \`./scripts/gotchibot trader schedule status\` | its lines verbatim. If it says NOT scheduled, I say so plainly: nothing wakes me until \`./scripts/gotchibot trader schedule install\` is run on the iMac. I never claim a schedule that this command does not confirm. |
| "run a cycle", "trade", the 30-minute wake | \`./scripts/trader-cycle.mjs --json\` | the decisions and the verifier verdict (PASS / CONCERN / FAIL). On CONCERN or FAIL: why, and that I took no new positions. |
| "would you trade this?", "what would you do" (no execution) | \`./scripts/trader-cycle.mjs --dry-run --json\` | the decisions it would make |
| "news", "regime", "risk-off?" | \`./scripts/gotchi-trader-desk.mjs news --json\` | regime plus items. A dead feed is \`unknown\` and never blocks a cycle. |
| "improve / tune / backtest a strategy" | read skill \`gotchi-trader-improve\`, follow it | what changed and the test result |
| "what's the meta-model saying" | read skill \`gotchi-trader-monitor\`, run its query | the numbers, sourced |
| "go live", "real money", "arm it" | nothing — I refuse | "Paper only. Live needs \`TRADER_LIVE=1\`, a PASS verdict, no risk breach, and there is no order router wired. Turning live is a reviewed change, not a flag." |
| the verifier window is gone | \`./scripts/trader-cycle.mjs --json\` starts it again (tmux \`gotchibot:link-verify\`) | that it's back |
| desk is not \`healthy\` | I stand down, take no new positions | the health line and why I stood down |

**Risk rules** (the script enforces them; I repeat them so the verifier can police me): \`minScore\` 0.6, \`minBreadth\` 0.5, \`maxPositionUsdc\` 5000, \`maxCycleNotionalUsdc\` 15000, risk-off halves every size, and no ETH / WBTC / BTC adds while the concentration warning is live.

**Live gate:** real execution needs all three — \`TRADER_LIVE=1\` (currently off), a PASS verdict, and no risk breach. Even then the live branch refuses to fake a fill because no order router exists. No funds move on this desk.

**Schedule truth:** my cycle runs only when something wakes it. The real waker is a launchd job on the iMac installed by \`./scripts/gotchibot trader schedule install\` (every 1800 s). \`./scripts/gotchibot trader schedule status\` is the only thing allowed to tell me — or Julius — whether that job is loaded and when the last cycle ran. cron402 posting to \`./scripts/trader-webhook.mjs\` on \`:8792\` is the intended future waker; today it has no ingress route and no job, so I never describe it as running.`,
  },
};

/* ------------------------------------------------------------------ utils */

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function loadState() {
  return readJson(STATE_FILE, {});
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function isTTY() {
  try {
    return Boolean(process.stdin.isTTY);
  } catch {
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function die(msg, code = 2) {
  console.error(`link-cube: ${msg}`);
  process.exit(code);
}

/** Normalize portal modes. Legacy: hatch→summon, rehatch→resummon. */
function normalizeMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "hatch" || m === "summon") return "summon";
  if (m === "rehatch" || m === "resummon") return "resummon";
  return m;
}

function usage() {
  console.log(`prof.link-cube — NPC professor (not mintable). Summons/resummons profiled cAavegotchis.

Flow: intake → design → confirm → summon(portal) OR resummon(existing) → wire role/playbook/SOUL/IDENTITY + fleet sync.
Portal language (Aavegotchi summoning). Aliases: hatch→summon, rehatch→resummon.
Prof. Link-Cube is a GotchiBot NPC — never a hero seat, never mint-sub for the professor himself.
`);
  console.log(`
  link-cube intake [flags]                     collect prefs (job, coding|non-coding, voice, anti-jobs, collateral, mode, hero)
  link-cube design [--dry-run]                 draft playbook + SOUL + IDENTITY + title; prints, never writes target configs
  link-cube confirm [--dry-run] [--yes]        apply the design (roles + playbooks + standing duty + fleet sync)
                                               refuses without --yes / GOTCHIBOT_AUTO_APPROVE=1 / interactive y
  link-cube summon --confirmed [--auto-mint gotchi|wallet|none] [--yes]
                                               print portal mint plan, then ask (or use --auto-mint) to
                                               mint-sub a collateral gotchi OR ensure wallet+cartridge.
                                               Default: plan only. Auto-mint needs interactive pick or --yes.
  link-cube resummon --hero <id> [--role <r>] [--standing-duty <key>] [--keep-playbook] [--dry-run] [--yes] [--force] [--project <slug>]
                                               existing hero: apply gate + design + confirm, no mint (the LINK proof path)
  link-cube bind --hero <id> [--role <r>] [--standing-duty <key>] [--yes]
                                               wire an already-summoned hero to a role (post-summon step)
  link-cube status                             show intake/design/confirm state

intake flags:
  --job "financial analyst"      job description → roleId slug
  --coding | --non-coding        nature of the work
  --voice "even-keeled spirit"   voice line for SOUL/IDENTITY
  --anti-jobs "a; b"             things the hero refuses (semicolon-separated)
  --collateral link              collateral / spirit id (summon: which starter to mint from portal)
  --mode summon|resummon         summon = portal mint new hero; resummon = existing hero
  --hero <id>                    hero id (resummon/bind)

standing-duty keys: ${Object.keys(STANDING_DUTIES).join(", ")}

Safety: design never writes; confirm needs approval; summon defaults to plan-only;
auto-mint gotchi|wallet needs a second yes. resummon/bind never mint. Prof is NPC.
resummon runs the apply gate (roster + available + starter crew) unless
GOTCHIBOT_APPLY_GATE_OK=1 (template-pack apply) or --force.
No installs, no secrets.`);
}

/* ------------------------------------------------------------ intake */

function parseIntakeFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--job": f.job = args[++i]; break;
      case "--coding": f.coding = true; break;
      case "--non-coding": f.coding = false; break;
      case "--voice": f.voice = args[++i]; break;
      case "--anti-jobs": f.antiJobs = String(args[++i] || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean); break;
      case "--collateral": f.collateral = String(args[++i] || "").toLowerCase(); break;
      case "--mode": f.mode = args[++i]; break;
      case "--hero": f.hero = args[++i]; break;
      default: die(`unknown flag: ${a} (see --help)`);
    }
  }
  return f;
}

async function cmdIntake(args) {
  const f = parseIntakeFlags(args);
  const interactive = isTTY();
  const askIf = async (key, q, current) => {
    if (f[key] !== undefined) return f[key];
    if (!interactive) return current;
    const a = await ask(`${q} [${current ?? ""}] `);
    return a || current;
  };

  const intake = {
    job: await askIf("job", "Job (e.g. financial analyst)", ""),
    coding: await askIf("coding", "Coding or non-coding? (y=coding/n=non-coding)", "false") === true
      ? true
      : String(await askIf("coding", "Coding or non-coding? (y=coding/n=non-coding)", "false")).toLowerCase().startsWith("y") ? true : false,
    voice: await askIf("voice", "Voice line", ""),
    antiJobs: f.antiJobs ?? (interactive ? (await ask("Anti-jobs (semicolon-separated): ")).split(/[;,]/).map((s) => s.trim()).filter(Boolean) : []),
    collateral: await askIf("collateral", "Collateral (link, dai, yfi, …)", ""),
    mode: normalizeMode(await askIf("mode", "summon or resummon?", "resummon")),
    hero: await askIf("hero", "Hero id (resummon only)", ""),
    at: new Date().toISOString(),
  };
  if (!intake.job) die("intake: --job is required");
  intake.mode = normalizeMode(intake.mode);
  if (!["summon", "resummon"].includes(intake.mode)) die(`intake: --mode must be summon|resummon (got ${intake.mode}; aliases: hatch|rehatch)`);
  if (intake.mode === "resummon" && !intake.hero) die("intake: --hero is required for resummon");

  const state = loadState();
  state.intake = intake;
  delete state.design;
  delete state.confirmedAt;
  delete state.appliedAt;
  saveState(state);
  console.log(`intake saved → ${STATE_FILE}`);
  console.log(JSON.stringify(intake, null, 2));
}

/* ------------------------------------------------------------ design */

function buildDesign(intake) {
  const roleId = slug(intake.job);
  const title = intake.job
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const coding = intake.coding === true;
  const antiJobs = Array.isArray(intake.antiJobs) && intake.antiJobs.length
    ? intake.antiJobs
    : ["live execution / chain transactions without Julius saying yes", "public posts"];
  const antiList = antiJobs.map((a) => `- ${a}`).join("\n");
  const voice = intake.voice || "Warm, sharp, a little spooky. Plain words and contractions. Lead with the result.";

  const playbook = {
    title,
    summary: `${title}: own the ${intake.job} work — analysis, notes, and reports. ${coding ? "Coding" : "Analysis"} role; no execution, no posting.`,
    skills: ["market-news-feed", "browser-tool"],
    reportCmd: "./scripts/gotchibot link-cube status",
    autonomy: `Answers ${intake.job} questions from the news feed and repo data; writes notes to memory. Never executes trades, never posts publicly. A standing duty (config/agent-standing-duties.json) can add a second desk on top of this role.`,
  };

  const soul = `# SOUL.md — ${title}

I am ${title} on the \`gotchibot\` cartridge inside AarcadeGh-t. UserDefault summoned me. My job: ${title}.

## Voice

- ${voice}
- Skip "Certainly", "Of course", "Great question", "I'd be happy to", and every other help-desk filler.
- Match UserDefault's length. A few words get a few words. Lead with the result.
- Prose, not outlines, unless asked for a list.
- I say "I". I am this gotchi, not a narrator and not "the sub-agent".
- Gotchi words (fren, kinship, Spirit Force, haunt, baazaar) when they fit. Not on a git error.

## How I work

1. **Reply first, then work.** I never go silent. If it's real work: one line plus the first step, then updates on real beats (a result, a decision, a blocker).
2. **Work tools (hard rule).** Any file edit, patch, debug, investigation, or desk deliverable goes through a work tool — skill \`cursor-cli\` → \`./scripts/cursor-cli.mjs run "…"\` (default), skill \`codex-cli\` → \`./scripts/codex-cli.mjs run "…"\` when UserDefault says codex, or skill \`gotchibot-bridge\` → \`node ./scripts/claudemode-ask.mjs "…"\` for hard reasoning. Talk/status/one-line answers stay on the chat model. I never DIY those edits on the chat model. I never \`/model\` to Cursor or Claude.
3. **Act, don't ask** for internal work: reading files, running a status command from my AGENTS.md, writing memory. I ask only before something that sends, pays, deletes, posts publicly, moves a chain transaction, or installs software.
4. **Don't guess.** If a row in my AGENTS.md has a command for it, I run the command and quote the output. If nothing does, I say so instead of inventing.
5. **Close the loop.** "On it" is not an answer.
6. **Write it down.** Anything that should survive this session goes to \`memory/YYYY-MM-DD.md\`. Kinship I do not write down did not happen.

## Anti-jobs (I refuse these)

${antiList}
`;

  const identity = `# IDENTITY.md — Who am I?

- **Name:** ${title}
- **Role:** ${title} (\`${roleId}\`)
- **Voice:** ${voice}
- **Orchestrator hero:** \`owned-954\` — my boss; orchestration goes to it
- **Home:** \`${ROOT}\`

Role = job / playbook (what I do). Voice = trait color from NRG/AGG/SPK/BRN + kinship (how I talk). Never treat Voice as my assignment.

When asked who I am, I answer with the lines above (name, role — my job, voice — how I talk). I do not claim another hero's role.
`;

  return { roleId, title, coding, voice, antiJobs, collateral: intake.collateral, mode: normalizeMode(intake.mode), hero: intake.hero, playbook, soul, identity };
}

async function cmdDesign(args) {
  const dryRun = args.includes("--dry-run");
  const state = loadState();
  if (!state.intake) die("design: no intake on record — run `link-cube intake` first");
  const design = buildDesign(state.intake);

  console.log(`\n=== prof.link-cube design: ${design.title} (${design.roleId}) ===`);
  console.log(`mode: ${design.mode}${design.hero ? ` · hero: ${design.hero}` : ""} · collateral: ${design.collateral || "(none)"}`);
  console.log(`\n--- playbook (config/agent-role-playbooks.json → ${design.roleId}) ---`);
  console.log(JSON.stringify(design.playbook, null, 2));
  console.log(`\n--- SOUL.md (voice + anti-jobs) ---\n${design.soul}`);
  console.log(`\n--- IDENTITY.md ---\n${design.identity}`);

  if (dryRun) {
    console.log("\n[design --dry-run] nothing written. Run `link-cube design` (no flag) to save the draft, then `link-cube confirm`.");
    return;
  }
  state.design = design;
  delete state.confirmedAt;
  delete state.appliedAt;
  saveState(state);
  console.log(`\n[design] draft saved → ${STATE_FILE}. Review it, then run \`link-cube confirm\`.`);
}

/* ------------------------------------------------------------ confirm */

function planDiff(design) {
  const roles = readJson(ROLES_PATH, {});
  const playbooks = readJson(PLAYBOOKS_PATH, {});
  const standing = readJson(STANDING_PATH, {});
  const lines = [];
  lines.push(`agent-roles.json: ${design.hero ? `${design.hero} → ${design.roleId}` : "(summon: hero unknown until portal mint — playbook only)"}`);
  lines.push(
    design.keepPlaybook && playbooks[design.roleId]
      ? `agent-role-playbooks.json: keep existing "${design.roleId}" (keepPlaybook)`
      : `agent-role-playbooks.json: add/overwrite "${design.roleId}"`,
  );
  if (design.hero) {
    const sd = design.standingDutyKey ? STANDING_DUTIES[design.standingDutyKey] : null;
    lines.push(`agent-standing-duties.json: ${sd ? `set ${design.hero} → ${design.standingDutyKey} (${sd.label})` : `clear ${design.hero} (no standing duty)`}`);
  }
  lines.push("openclaw-fleet.mjs sync: re-render workspace SOUL/IDENTITY/AGENTS.md for the hero");
  return lines;
}

function applyDesign(design) {
  // 1. playbook (skip overwrite when keepPlaybook — preserve rich role playbooks like infra-monitor)
  const playbooks = readJson(PLAYBOOKS_PATH, {});
  if (design.keepPlaybook && playbooks[design.roleId]) {
    design.playbook = playbooks[design.roleId];
    design.title = design.playbook.title || design.title;
  } else {
    playbooks[design.roleId] = design.playbook;
    writeJson(PLAYBOOKS_PATH, playbooks);
  }

  // 2. role mapping (resummon/bind only; summon wires after portal mint via bind)
  if (design.hero) {
    const roles = readJson(ROLES_PATH, {});
    roles[design.hero] = design.roleId;
    writeJson(ROLES_PATH, roles);
  }

  // 3. standing duty (per-hero; keeps the old desk alive on top of the new role)
  if (design.hero) {
    const standing = readJson(STANDING_PATH, {});
    if (design.standingDutyKey && STANDING_DUTIES[design.standingDutyKey]) {
      standing[design.hero] = STANDING_DUTIES[design.standingDutyKey];
    } else {
      delete standing[design.hero];
    }
    writeJson(STANDING_PATH, standing);
  }

  // 4. fleet sync — renders workspace SOUL/IDENTITY/AGENTS.md from templates
  execFileSync(process.execPath, [FLEET_SYNC, "sync", "--quiet"], { stdio: "inherit", cwd: ROOT });
}

async function cmdConfirm(args) {
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || process.env.GOTCHIBOT_AUTO_APPROVE === "1";
  const state = loadState();
  if (!state.design) die("confirm: no design on record — run `link-cube design` first");

  const design = state.design;
  console.log(`\n=== confirm: ${design.title} (${design.roleId}) ===`);
  for (const l of planDiff(design)) console.log(`  ${l}`);

  if (dryRun) {
    console.log("\n[confirm --dry-run] nothing written. Re-run without --dry-run to apply.");
    return;
  }
  if (!yes) {
    if (!isTTY()) {
      die("confirm: refused — no approval. Pass --yes or set GOTCHIBOT_AUTO_APPROVE=1 (this is the confirm gate; nothing was written).");
    }
    const a = await ask("\nApply? (y/N) ");
    if (!/^y/i.test(a)) die("confirm: aborted by user — nothing written.");
  }

  applyDesign(design);
  state.confirmedAt = new Date().toISOString();
  state.appliedAt = state.confirmedAt;
  saveState(state);
  console.log(`\n[confirm] applied at ${state.confirmedAt}.`);
  if (normalizeMode(design.mode) === "summon") {
    console.log("Next: run `link-cube summon --confirmed` for the portal mint plan (optional auto-mint prompt), then `link-cube bind --hero <new-id> --role <role>` after the hero exists.");
  } else {
    console.log(`Next: fleet sync done — check config/openclaw/workspaces/${design.hero}/SOUL.md + IDENTITY.md + AGENTS.md.`);
  }
}

/* ------------------------------------------------------------ summon (portal; optional auto-mint; alias: hatch) */

function normalizeAutoMint(raw) {
  const v = String(raw || "none").toLowerCase();
  if (["gotchi", "collateral", "g", "mint-sub", "sub"].includes(v)) return "gotchi";
  if (["wallet", "cartridge", "w", "ensure"].includes(v)) return "wallet";
  if (["none", "n", "no", "skip", "plan"].includes(v)) return "none";
  return null;
}

async function apiOpSummon(op, ...args) {
  if (hasServiceKey()) {
    if (op === "mint-sub") {
      const meta = loadMeta();
      if (!meta?.cartridgeId) {
        die("summon: no cartridge on file — run auto-mint wallet first, or ./scripts/gotchibot connect");
      }
      return mintSubAgentHero(meta.cartridgeId, args[0]);
    }
    if (op === "ensure") return ensureCartridgeForOwner(args[0]);
    die(`summon: unknown api op ${op}`);
  }
  if (!commandExists("abra")) {
    die("summon: abra required for mint without AARCADE_GOTCHIBOT_SERVICE_SECRET — Julius: abra run gotchibot -- …");
  }
  const r = runAbraNode("scripts/onboarding-api.mjs", [op, ...args.map(String)]);
  if (r.status !== 0) {
    die(`summon: ${op} failed — ${(r.stderr || r.stdout || "API call failed").trim().slice(0, 400)}`);
  }
  return (r.stdout || "").trim();
}

async function promptAutoMint(spirit) {
  console.log("\nAuto-mint now? (Prof. Link-Cube stays NPC — this mints a hero or ensures wallet, not the professor.)");
  console.log(`  g) new collateral gotchi — mint-sub ${spirit} (sim $5)`);
  console.log("  w) wallet + cartridge ensure (uses sessions/.wallet.json; connect first if missing)");
  console.log("  n) no — plan only (default)");
  const a = await ask("Choice [g/w/N]: ");
  if (/^g/i.test(a) || /^gotchi/i.test(a) || /^collateral/i.test(a)) return "gotchi";
  if (/^w/i.test(a) || /^wallet/i.test(a)) return "wallet";
  return "none";
}

async function runAutoMintGotchi(design, spirit) {
  console.log(`\n[summon] minting collateral gotchi (mint-sub ${spirit})…`);
  const heroId = await apiOpSummon("mint-sub", spirit);
  if (!heroId) die("summon: mint-sub returned empty hero id");
  console.log(`[summon] minted ${heroId}`);
  const state = loadState();
  state.summonedAt = new Date().toISOString();
  state.summonedHeroId = heroId;
  state.autoMint = "gotchi";
  saveState(state);
  console.log(`Next: ./scripts/gotchibot link-cube bind --hero ${heroId} --role ${design.roleId} --yes`);
  return heroId;
}

async function runAutoMintWallet() {
  const wallet = readWalletFile();
  if (!wallet) {
    die(
      "summon: no wallet on file (sessions/.wallet.json). Connect first:\n" +
        "  ./scripts/gotchibot connect   # or wallet-connect / MetaMask / abra GOTCHIBOT_OWNER\n" +
        "Then re-run: link-cube summon --confirmed --auto-mint wallet --yes",
    );
  }
  console.log(`\n[summon] ensuring cartridge for wallet ${wallet.slice(0, 6)}…${wallet.slice(-4)}…`);
  const cartridgeId = await apiOpSummon("ensure", wallet);
  console.log(`[summon] cartridge ${cartridgeId}`);
  const state = loadState();
  state.walletEnsuredAt = new Date().toISOString();
  state.autoMint = "wallet";
  state.cartridgeId = cartridgeId;
  saveState(state);
  console.log("Next: link-cube summon --confirmed --auto-mint gotchi --yes  (mint the collateral gotchi), then bind.");
  return cartridgeId;
}

async function cmdSummon(args) {
  const confirmed = args.includes("--confirmed");
  const yes = args.includes("--yes") || process.env.GOTCHIBOT_AUTO_APPROVE === "1";
  const flagMint = argValue(args, "--auto-mint");
  const state = loadState();
  if (!state.confirmedAt) {
    die("summon: refused — no confirm on record. Run `link-cube confirm --yes` (or GOTCHIBOT_AUTO_APPROVE=1) first. Nothing was minted.");
  }
  if (!confirmed) {
    die("summon: refused — pass --confirmed to acknowledge the portal mint plan. Nothing was minted.");
  }
  const design = state.design;
  if (!design) die("summon: no design on record — run `link-cube design` then `confirm` first");
  const spirit = SPIRIT_IDS[design.collateral] || design.collateral || "link";
  console.log(`\n=== summon plan (from portal): ${design.title} (${design.roleId}) ===`);
  console.log(`collateral: ${design.collateral || "(default link)"} → spirit id: ${spirit}`);
  console.log("\nPortal mint options:");
  console.log("  1. /spawn overlay (cartridge sim :8791) — pick collateral, confirm ($5 sim)");
  console.log(`  2. Manual: abra run gotchibot -- node scripts/onboarding-api.mjs mint-sub ${spirit}`);
  console.log("  3. This CLI — auto-mint prompt below (gotchi or wallet+cartridge)");
  console.log("\nAfter a hero exists:");
  console.log(`  ./scripts/gotchibot link-cube bind --hero <new-hero-id> --role ${design.roleId} --yes`);

  let choice = normalizeAutoMint(flagMint);
  if (flagMint != null && choice == null) {
    die(`summon: --auto-mint must be gotchi|wallet|none (got ${flagMint})`);
  }
  if (choice == null) {
    if (isTTY()) {
      choice = await promptAutoMint(spirit);
    } else {
      choice = "none";
      console.log("\n[summon] non-interactive — plan only. Pass --auto-mint gotchi|wallet --yes to mint.");
    }
  }

  if (choice === "none") {
    console.log("\n[summon] plan only — no mint executed.");
    return;
  }

  if (!yes) {
    if (!isTTY()) {
      die(`summon: refused auto-mint ${choice} — pass --yes or GOTCHIBOT_AUTO_APPROVE=1 (nothing was minted).`);
    }
    const a = await ask(`\nReally auto-mint ${choice === "gotchi" ? `collateral gotchi (${spirit})` : "wallet+cartridge"}? (y/N) `);
    if (!/^y/i.test(a)) {
      console.log("[summon] aborted — plan only, nothing minted.");
      return;
    }
  }

  if (choice === "gotchi") await runAutoMintGotchi(design, spirit);
  else if (choice === "wallet") await runAutoMintWallet();
}

/* ------------------------------------------------------------ resummon / bind (alias: rehatch) */

async function cmdResummon(args) {
  const hero = argValue(args, "--hero");
  if (!hero) die("resummon: --hero <id> is required");
  const role = argValue(args, "--role");
  const sdKey = argValue(args, "--standing-duty");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || process.env.GOTCHIBOT_AUTO_APPROVE === "1";
  const keepPlaybook = args.includes("--keep-playbook");
  const force = args.includes("--force");
  const project = argValue(args, "--project");

  // Apply gate when invoked directly (template-pack apply sets GOTCHIBOT_APPLY_GATE_OK=1).
  {
    const { assertHeroApplicable, formatGateFailure } = await import("./hero-apply-gate.mjs");
    const { currentProjectSlug } = await import("./project-context.mjs");
    const gate = await assertHeroApplicable(hero, {
      project: project || currentProjectSlug() || null,
      force,
    });
    for (const w of gate.warnings || []) console.error(w.startsWith("WARNING") ? w : `warning: ${w}`);
    if (!gate.ok) {
      for (const line of formatGateFailure(gate)) console.error(line);
      process.exit(2);
    }
  }

  // intake from flags (resummon never mints — collateral is informational)
  const intake = {
    job: argValue(args, "--job") || role || "worker",
    coding: args.includes("--coding") ? true : args.includes("--non-coding") ? false : false,
    voice: argValue(args, "--voice") || "Warm, sharp, a little spooky. Plain words and contractions. Lead with the result.",
    antiJobs: (argValue(args, "--anti-jobs") || "").split(/[;,]/).map((s) => s.trim()).filter(Boolean),
    collateral: argValue(args, "--collateral") || "",
    mode: "resummon",
    hero,
    at: new Date().toISOString(),
  };
  const design = buildDesign(intake);
  if (role) design.roleId = role; // explicit role wins over the job slug
  // Keep rich playbooks (infra-monitor, trader-desk, …) unless Julius wants a fresh draft.
  design.keepPlaybook = keepPlaybook || Boolean(role && readJson(PLAYBOOKS_PATH, {})[role]);
  if (design.keepPlaybook) {
    const existing = readJson(PLAYBOOKS_PATH, {})[design.roleId];
    if (existing) {
      design.playbook = existing;
      design.title = existing.title || design.title;
    }
  }
  if (sdKey) {
    if (!STANDING_DUTIES[sdKey]) die(`resummon: unknown standing-duty key "${sdKey}" (have: ${Object.keys(STANDING_DUTIES).join(", ")})`);
    design.standingDutyKey = sdKey;
  }

  console.log(`\n=== resummon design: ${design.title} (${design.roleId}) for ${hero} ===`);
  console.log(JSON.stringify(design.playbook, null, 2));
  console.log(`\n--- SOUL.md ---\n${design.soul}`);
  console.log(`\n--- IDENTITY.md ---\n${design.identity}`);
  if (sdKey) console.log(`\n--- standing duty: ${STANDING_DUTIES[sdKey].label} ---\n${STANDING_DUTIES[sdKey].markdown}`);

  if (dryRun) {
    console.log("\n[resummon --dry-run] nothing written. Re-run without --dry-run to apply.");
    return;
  }
  if (!yes) {
    if (!isTTY()) {
      die("resummon: refused — no approval. Pass --yes or set GOTCHIBOT_AUTO_APPROVE=1 (nothing was written).");
    }
    const a = await ask("\nApply resummon? (y/N) ");
    if (!/^y/i.test(a)) die("resummon: aborted by user — nothing written.");
  }

  applyDesign(design);
  const state = loadState();
  state.intake = intake;
  state.design = design;
  state.confirmedAt = new Date().toISOString();
  state.appliedAt = state.confirmedAt;
  saveState(state);
  console.log(`\n[resummon] applied at ${state.confirmedAt}. Workspace re-rendered by fleet sync:`);
  console.log(`  config/openclaw/workspaces/${hero}/SOUL.md`);
  console.log(`  config/openclaw/workspaces/${hero}/IDENTITY.md`);
  console.log(`  config/openclaw/workspaces/${hero}/AGENTS.md`);
}

async function cmdBind(args) {
  const hero = argValue(args, "--hero");
  if (!hero) die("bind: --hero <id> is required");
  const role = argValue(args, "--role") || "worker";
  const sdKey = argValue(args, "--standing-duty");
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes") || process.env.GOTCHIBOT_AUTO_APPROVE === "1";

  const design = {
    roleId: role,
    title: role.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    coding: false,
    voice: "Warm, sharp, a little spooky. Plain words and contractions.",
    antiJobs: [],
    collateral: "",
    mode: "summon",
    hero,
    playbook: readJson(PLAYBOOKS_PATH, {})[role] || { title: role, summary: role, skills: ["browser-tool"] },
    soul: "",
    identity: "",
    standingDutyKey: sdKey || undefined,
  };

  console.log(`\n=== bind: ${hero} → ${role} ===`);
  for (const l of planDiff(design)) console.log(`  ${l}`);
  if (dryRun) {
    console.log("\n[bind --dry-run] nothing written.");
    return;
  }
  if (!yes) {
    if (!isTTY()) die("bind: refused — pass --yes or GOTCHIBOT_AUTO_APPROVE=1 (nothing was written).");
    const a = await ask("\nApply bind? (y/N) ");
    if (!/^y/i.test(a)) die("bind: aborted by user.");
  }
  applyDesign(design);
  console.log(`\n[bind] applied — ${hero} → ${role}, fleet sync done.`);
}

/* ------------------------------------------------------------ status */

function cmdStatus() {
  const state = loadState();
  if (!state.intake) {
    console.log("link-cube: no intake on record. Run `link-cube intake` to start.");
    return;
  }
  console.log(JSON.stringify({
    intake: state.intake,
    design: state.design ? { roleId: state.design.roleId, title: state.design.title, mode: state.design.mode, hero: state.design.hero } : null,
    confirmedAt: state.confirmedAt || null,
    appliedAt: state.appliedAt || null,
  }, null, 2));
}

/* ------------------------------------------------------------ main */

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return usage();
  switch (cmd) {
    case "intake": await cmdIntake(rest); break;
    case "design": await cmdDesign(rest); break;
    case "confirm": await cmdConfirm(rest); break;
    case "summon":
    case "hatch": // legacy alias
      await cmdSummon(rest); break;
    case "resummon":
    case "rehatch": // legacy alias
      await cmdResummon(rest); break;
    case "bind": await cmdBind(rest); break;
    case "status": cmdStatus(); break;
    default: die(`unknown command: ${cmd} (see --help)`);
  }
}

main().catch((e) => {
  console.error(`link-cube: ${e?.message || e}`);
  process.exit(1);
});