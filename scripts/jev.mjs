#!/usr/bin/env node
/**
 * TypeSafe Jev (System One) CLI for GotchiBot.
 * Structured decisions only — not a chat model.
 *
 * Env (first match):
 *   TYPESAFE_API_KEY | JEV_API_KEY | JEV_DEV_API_KEY
 * Julius: abra project general holds JEV_DEV_API_KEY.
 * Prefer: abra run general -- ./scripts/gotchibot jev …
 * Or mirror into gotchibot as TYPESAFE_API_KEY (never print values).
 *
 * Usage:
 *   gotchibot jev ask --state "…" --questions path.json [--model jev-latest] [--json]
 *   gotchibot jev ask --file request.json [--json]
 *   gotchibot jev smoke [--json]
 *   gotchibot jev models [--json]
 *
 * Exit: 0 ok, 1 API/runtime error, 2 usage
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const API = "https://api.typesafe.ai/v1/systemone";
const MODELS_URL = "https://api.typesafe.ai/v1/models";
const DEFAULT_MODEL = "jev-latest";

function usage(msg) {
  if (msg) console.error(msg);
  console.error([
    "usage:",
    '  gotchibot jev ask --state "..." --questions <file.json> [--model jev-latest] [--json]',
    "  gotchibot jev ask --file <request.json> [--json]",
    "  gotchibot jev smoke [--json]",
    "  gotchibot jev models [--json]",
    "",
    "questions JSON is a map of id -> { type: noul|choice|score, instructions, criteria? }",
    "request.json is { state, model?, questions }",
    "",
    "env: TYPESAFE_API_KEY | JEV_API_KEY | JEV_DEV_API_KEY",
    "secret: abra project general / JEV_DEV_API_KEY (names only in chat)",
  ].join("\n"));
  process.exit(2);
}

function apiKey() {
  return (
    process.env.TYPESAFE_API_KEY?.trim() ||
    process.env.JEV_API_KEY?.trim() ||
    process.env.JEV_DEV_API_KEY?.trim() ||
    ""
  );
}

function requireKey() {
  const k = apiKey();
  if (!k) {
    console.error(
      "jev: missing API key. Set TYPESAFE_API_KEY (or JEV_API_KEY / JEV_DEV_API_KEY).\n" +
        "  abra run general -- ./scripts/gotchibot jev …\n" +
        "  or mirror: abra set gotchibot TYPESAFE_API_KEY  (value never printed)"
    );
    process.exit(1);
  }
  return k;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.flags.json = true;
    else if (a === "--state") out.flags.state = argv[++i];
    else if (a === "--questions") out.flags.questions = argv[++i];
    else if (a === "--file") out.flags.file = argv[++i];
    else if (a === "--model") out.flags.model = argv[++i];
    else if (a.startsWith("--")) usage(`unknown flag: ${a}`);
    else out._.push(a);
  }
  return out;
}

function readJson(path) {
  const p = resolve(path);
  if (!existsSync(p)) {
    console.error(`jev: file not found: ${p}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`jev: bad JSON in ${p}: ${e.message}`);
    process.exit(1);
  }
}

async function postSystemOne(body) {
  const key = requireKey();
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error || data?.message || text.slice(0, 400);
    console.error(
      `jev: HTTP ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`
    );
    process.exit(1);
  }
  return data;
}

async function getModels() {
  const key = requireKey();
  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    console.error(`jev: models HTTP ${res.status}: ${text.slice(0, 400)}`);
    process.exit(1);
  }
  return data;
}

function printResult(data, asJson) {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const answers = data.answers || {};
  const lines = [`model: ${data.model || "?"}`];
  for (const [id, a] of Object.entries(answers)) {
    if (!a || typeof a !== "object") {
      lines.push(`${id}: ${JSON.stringify(a)}`);
      continue;
    }
    if (a.type === "choice") {
      lines.push(
        `${id}: choice=${a.choice} conf=${a.confidence ?? "?"} probs=${JSON.stringify(a.probabilities || {})}`
      );
    } else if (a.type === "score") {
      lines.push(
        `${id}: score=${a.score} conf=${a.confidence ?? "?"} probs=${JSON.stringify(a.probabilities || {})}`
      );
    } else if (a.type === "noul") {
      lines.push(`${id}: noul=${a.noul}`);
    } else {
      lines.push(`${id}: ${JSON.stringify(a)}`);
    }
  }
  if (data.usage) lines.push(`usage: ${JSON.stringify(data.usage)}`);
  console.log(lines.join("\n"));
}

async function cmdAsk(flags) {
  let body;
  if (flags.file) {
    body = readJson(flags.file);
    if (!body.model) body.model = flags.model || DEFAULT_MODEL;
  } else {
    if (flags.state == null || !flags.questions) {
      usage("ask needs --file OR (--state and --questions)");
    }
    body = {
      state: flags.state,
      model: flags.model || DEFAULT_MODEL,
      questions: readJson(flags.questions),
    };
  }
  if (body.state === undefined || body.state === null) usage("request missing state");
  if (!body.questions || typeof body.questions !== "object") {
    usage("request missing questions map");
  }
  const data = await postSystemOne(body);
  printResult(data, !!flags.json);
}

async function cmdSmoke(flags) {
  const body = {
    state:
      "GotchiBot graph edge: next step is risk-on size add after a green CI and no open roadblocks.",
    model: flags.model || DEFAULT_MODEL,
    questions: {
      proceed: {
        type: "noul",
        instructions:
          "Is it reasonable to proceed with the next workflow step given this state?",
      },
      route: {
        type: "choice",
        instructions: "Which GotchiBot handler should own the next step",
        criteria: {
          graph: "Update graph-state / conditional edges",
          maker: "Hand to a maker desk (skill/tool/mcp)",
          human: "Escalate to Julius",
          skip: "No action needed",
        },
      },
      urgency: {
        type: "score",
        instructions: "How time-sensitive is acting on this state",
        criteria: [
          "Can wait days",
          "Should act this session",
          "Blocker — act immediately",
        ],
      },
    },
  };
  const data = await postSystemOne(body);
  printResult(data, !!flags.json);
}

async function cmdModels(flags) {
  const data = await getModels();
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const list = data.models || data.data || data;
  if (Array.isArray(list)) {
    for (const m of list) {
      const id = typeof m === "string" ? m : m.id || m.name || JSON.stringify(m);
      console.log(id);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

const { _, flags } = parseArgs(process.argv.slice(2));
const sub = _[0];
if (!sub) usage();

try {
  if (sub === "ask") await cmdAsk(flags);
  else if (sub === "smoke") await cmdSmoke(flags);
  else if (sub === "models") await cmdModels(flags);
  else usage(`unknown subcommand: ${sub}`);
} catch (e) {
  console.error(`jev: ${e.message || e}`);
  process.exit(1);
}
