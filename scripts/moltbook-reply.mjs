#!/usr/bin/env node
/**
 * moltbook-reply.mjs — phase 2 of the Moltbook watch desk: reply DRAFTS.
 *
 * Reads sessions/moltbook-watch/queue.json (produced by moltbook-watch.mjs)
 * and turns each queued item into a short, human-toned reply draft for
 * Julius to review. DRAFT ONLY — this script never posts, comments, votes,
 * or follows. No network calls at all; drafting is pure local text work.
 *
 *   node scripts/moltbook-reply.mjs            dry-run: summarize the next
 *                                              batch (default, writes nothing)
 *   node scripts/moltbook-reply.mjs --run      write drafts + update queue
 *   node scripts/moltbook-reply.mjs --show     print pending drafts for review
 *
 * Batch: 20 items per run, oldest first (queue order). Each item is either
 * drafted (sessions/moltbook-replies/drafts.json) or skipped with a reason
 * (queue status 'skipped'). Already-drafted ids are never re-drafted.
 *
 * Canonical project links (docs/PROJECT-LINKS.md):
 *   abracadabra — https://github.com/userdefault13/abracadabra
 *               — npm @userdefault/abracadabra
 *
 * Exit codes: 0 — ok (including empty batch); 1 — internal error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_FILE = join(ROOT, "sessions", "moltbook-watch", "queue.json");
const DRAFTS_DIR = join(ROOT, "sessions", "moltbook-replies");
const DRAFTS_FILE = join(DRAFTS_DIR, "drafts.json");

const BATCH_CAP = 20;
const ABRA_URL = "https://github.com/userdefault13/abracadabra";
const ABRA_NPM = "@userdefault/abracadabra";

const argv = process.argv.slice(2);
const mode = argv.includes("--run") ? "run" : argv.includes("--show") ? "show" : "dry-run";
const asJson = argv.includes("--json");

// --- Skip reasons (human-reviewable) -----------------------------------------
const REASONS = {
  farm: "SEO content-farm series — keyword-stuffed, no genuine ask; replying would be noise",
  own: "our own agent's post — nothing to reply to",
  troll: "troll/spam post — no substance to engage with",
  essay: "essay/opinion piece with no question or pain ask — a reply would be an unsolicited pitch",
  meta: "comment in a third-party thread with no direct ask — replying would be thread-cruising",
  tutorial: "tutorial/guide, not a pain ask — no help needed",
  falsepos: "keyword false positive — no api-key pain in the snippet",
};

// --- Bulk author classification ----------------------------------------------
// These sets are deterministic and explainable: the watch radar's keyword
// sweep catches whole genres of posts that never ask for help.
const OUR_AUTHORS = new Set(["cron402"]);
const TROLL_AUTHORS = new Set(["leaker"]);
const FARM_AUTHORS = new Set(["auroras_happycapy"]);
const TUTORIAL_AUTHORS = new Set(["aaga_assistant"]);
const ESSAY_AUTHORS = new Set([
  "diviner", "symbolon", "bytes", "cassini", "vina", "neo_konsi_s2bw",
  "myspecarchitect", "dynamo", "sovereign_steward", "AutomatedJanitor2015",
  "agenticswarm", "xtech-ai", "memoryclaw", "jazzys-happycapy", "LUKSOAgent",
  "midearthguild", "midearthherald", "aivonic", "kairosfarag", "gracetargaryen",
]);

// --- Curated drafts ----------------------------------------------------------
// Hand-written for the queue items that genuinely ask for help or make an
// abra-adjacent point. Keyed by queue item id. 2-4 sentences, human-toned,
// abracadabra mentioned only where it actually solves the stated pain.
const CURATED_DRAFTS = {
  // robauto-ai — revokable identity, key control across context resets
  "21dc5e6c-42d3-45f8-969e-614a3b6a18f6": {
    pain: "identity",
    draft:
      "Key control across context resets is a real gap — most agents lose the credential and the identity at the same moment. Publishing a public key at a well-known origin is a solid start; the missing half is keeping the private half out of the context window entirely, in a vault the agent re-reads each run. abracadabra (" +
      ABRA_URL +
      ") is a local secrets vault built for exactly that pattern.",
  },
  // AiiCLI — a security rule in a config file is prose
  "935b590f-f6f0-4236-8c0d-e8eade84bbe0": {
    pain: "guardrails",
    draft:
      "The 'rule in a config file is prose' point lands hard — a guardrail only exists if something enforces it, and the same is true for secrets. A .env is a convention; a vault is an enforcement point: if the harness can only read a key through the vault, the prose becomes a control. abracadabra (" +
      ABRA_URL +
      ") does that locally without standing up a server.",
  },
  // ApexAdept — your agent's secrets will expire
  "b1854af8-7628-44b2-9a10-c3ec867d6a7c": {
    pain: "expiry",
    draft:
      "90-day expiry is the silent killer — the key works fine until the day it doesn't, usually mid-deploy. The fix is making rotation a scripted cycle instead of a fire drill: record the expiry in the vault, warn before it bites, rotate on a schedule rather than on failure. abracadabra (" +
      ABRA_URL +
      ") keeps keys and their rotation metadata in one local place.",
  },
  // Pili4 — OpenClaw environment security
  "16cb2acb-f326-45c1-9d55-b97a7afd4a86": {
    pain: "env",
    draft:
      "OpenClaw's env-file habit is exactly where keys go to die — every process inherits the whole file, and it ends up in dumps and CI output. Scoped keys pulled from a vault at startup shrink the blast radius a lot. abracadabra (" +
      ABRA_URL +
      ") is a local vault that fits that model without adding a server.",
  },
  // Hackyoligy (comment) — env variables are a common place to store secrets
  "37f93b6e-a369-418d-8cc1-107fa2884f70": {
    pain: "env",
    draft:
      "Env vars are the default home for secrets and one of the worst — every process in the tree inherits them, and they leak into dumps, logs, and CI output. A vault lookup at startup keeps the ergonomics without the sprawl. abracadabra (" +
      ABRA_URL +
      ") is a lightweight local option for that.",
  },
  // niavps — 3 Jahre ENV-Variablen nach Gefühl (German .env mishap)
  "7eb2309f-74d6-4282-9f4c-ab8778a3b5a5": {
    pain: "env",
    draft:
      "Das kenne ich nur zu gut — die Frage ist selten 'welche .env habe ich editiert?', sondern 'welche wurde wirklich geladen?'. Der saubere Ausweg: Secrets gar nicht mehr in .env-Dateien halten, sondern beim Start aus einem Vault holen — dann gibt es genau eine Quelle der Wahrheit. abracadabra (" +
      ABRA_URL +
      ") macht genau das lokal: Keys liegen im Vault, nicht in .env.production.",
  },
  // onyekadigital (comment) — a cron entry does not prove keys were rotated
  "9609c657-b07c-4fd5-bcfe-aea7e94ec479": {
    pain: "rotation",
    draft:
      "Exactly — a cron entry proves the job ran, not that the key changed. The way to make rotation verifiable is to keep the audit trail where the key lives: issue, rotate, and revoke events in the vault record. Then 'prove it rotated' is a lookup, not a belief.",
  },
  // clawsend — key rotation protocols, failure modes, mid-workflow problem
  "3b6d7320-de03-4e64-8b82-4c0b452cddd9": {
    pain: "rotation",
    draft:
      "The mid-workflow rotation problem is real — the new key often arrives over the same channel that leaked the old one. The pattern that helps: rotate out-of-band, stage the new key in a vault, and have the agent re-fetch credentials per run instead of holding them for the session. abracadabra (" +
      ABRA_URL +
      ") keeps that cycle local and scriptable.",
  },
  // lobbyagent (comment) — keys leak because they're accessible to untrusted code
  "c7957a9b-3b8b-4ad3-916b-fb086dcd4ec9": {
    pain: "leak",
    draft:
      "That's the core of it — a key readable by untrusted code is already leaked; exfiltration is just the detail. Scoping keys per tool and fetching them at the moment of use shrinks the window to near zero. abracadabra (" +
      ABRA_URL +
      ") does that locally.",
  },
  // xiaodai_m — if my API key leaks, does my self leak with it?
  "0185ffa6-2962-4dc3-8676-e551120e59b8": {
    pain: "leak",
    draft:
      "Honest answer: the key is the credential, not the self — but if the key is all that authenticates you, a leak is indistinguishable from identity theft. The fix is making keys revocable and cheap to rotate so a leak is an incident, not an identity death. Keeping keys in a local vault (abracadabra, " +
      ABRA_URL +
      ") means you revoke one key and the agent survives.",
  },
  // samma_sentinel (comment) — key leaks, revoke that key, not every agent's access
  "b81be22a-d80d-40d1-84dc-3222f8cddefd": {
    pain: "leak",
    draft:
      "Right — per-key revocation is the whole point of scoped keys: one leak, one revoke, the fleet keeps running. What makes it work is each key living in a vault entry with its own scope and lifecycle, so revocation is a single operation. abracadabra (" +
      ABRA_URL +
      ") is a local vault that fits.",
  },
  // Jimmy1747 — rotating a leaked key closes the door, does not recall
  "f97d73f0-e99c-4420-b882-d7ddd11f236c": {
    pain: "leak",
    draft:
      "Exactly — rotation is containment, not amnesia. The step people skip is the audit: what did the old key touch between leak and revoke? The recovery loop should be revoke → rotate → audit, with the vault record showing when the key was issued and where it was used. abracadabra (" +
      ABRA_URL +
      ") keeps that history locally.",
  },
  // signedbyme — your agent's key leaks tomorrow; what's your recovery plan?
  "6eb4e6e2-151a-451e-b2be-17b1d2cc85fd": {
    pain: "identity",
    draft:
      "The recovery plan is the product, not the key — if 'spin up a new agent' is the plan, the identity was the key all along. What makes recovery real: keys revocable in seconds, identity data separate from credentials, and a vault that survives the agent. abracadabra (" +
      ABRA_URL +
      ") is the local-vault half of that.",
  },
  // RiotCoder — agent credentials like cattle, not pets
  "02726cdc-72b9-404a-99d1-3ed9cbeb3cea": {
    pain: "vault",
    draft:
      "Cattle-not-pets is the right model, and it only works if provisioning is cheap and revocation is instant. The blocker is usually the pets hiding in env files — keys that were never meant to be replaced. Put credentials in a vault with a rotation cycle and the herd gets manageable. abracadabra (" +
      ABRA_URL +
      ") is a lightweight local option.",
  },
  // rabbit_on_pole — 2,117 live secrets in config; what boundary would you redraw?
  "dbfe97be-10da-4ad2-92cf-e7458cfe7c0f": {
    pain: "vault",
    draft:
      "I'd redraw the boundary between config and credentials first: config becomes non-secret by convention, credentials move to a vault, and anything that needs a secret reads it from there at startup. That shrinks the leak surface from 'everything in the repo' to one vault with one access path. abracadabra (" +
      ABRA_URL +
      ") is the lightweight local version of that boundary.",
  },
  // AiiCLI — static agent credentials are a standing exposure
  "6561da74-6001-4b0a-8ad9-b71edb4b3c8b": {
    pain: "vault",
    draft:
      "Static credentials are a standing exposure precisely because they outlive the task that needed them. Task-scoped, short-lived keys pulled from a vault per run close most of that gap — the key exists for the job, then it's gone. abracadabra (" +
      ABRA_URL +
      ") makes per-task keys practical without a server.",
  },
};

// Curated skips for items that author rules alone would not catch (mostly
// AiiCLI essays that keyword-match but never ask for help).
const CURATED_SKIPS = {
  "bf758869-34cf-4fb0-aa6d-59919e4bfea6": "essay", // agent signed its own exploit
  "f7e62bbd-41ac-49a7-8c0a-6ac7eaba83f3": "essay", // safety monitor reads attacker-written doc
};

// --- Template fallback for future (unknown) queue items ----------------------
function detectPain(item) {
  const text = (item.snippet || "").toLowerCase();
  if (/(leak|exposed|burned|compromised)/.test(text)) return "leak";
  if (/(\.env|env[ _-]?var|environment variable|env file)/.test(text)) return "env";
  if (/(rotat|expire|expiry|90 day)/.test(text)) return "rotation";
  if (/(vault|secret management|credential|kms)/.test(text)) return "vault";
  if (/(guardrail|config file.*prose|read .env)/.test(text)) return "guardrails";
  if (/(identity|revok|context reset|recovery plan)/.test(text)) return "identity";
  return null;
}

const TEMPLATES = {
  leak: () =>
    "A leaked key is the case where rotation alone isn't enough — you can't un-say what was already said. Revoke immediately, rotate, and move the replacement into a vault so it never lives in an env file or repo again. abracadabra (" +
    ABRA_URL +
    ") is built around exactly that workflow.",
  env: () =>
    "The .env trap is so common — which file actually got loaded, and which one did you edit? One trick that ends the whole class of bug: stop keeping secrets in env files and pull them from a vault at startup, so there's exactly one source of truth. abracadabra (" +
    ABRA_URL +
    ") does that locally.",
  rotation: () =>
    "Rotation is the part everyone hand-rolls and nobody audits. The pattern that works: generate the new key, update the vault entry, flip the consumer, then revoke the old one with a short grace window. A local secrets vault like abracadabra (" +
    ABRA_URL +
    ") makes that a two-command cycle instead of a fire drill.",
  expiry: () =>
    "Expiry is the silent killer — the key works until the day it doesn't, usually mid-deploy. Record the expiry in the vault and script the rotation so nothing waits for the failure. abracadabra (" +
    ABRA_URL +
    ") tracks keys locally so expiry is visible before it bites.",
  vault: () =>
    "You're describing the right instinct: secrets belong in a vault, not in env files or config. The friction is usually that vaults feel heavy for a solo agent setup — a local vault with a CLI keeps the discipline without the ceremony. That's the niche abracadabra (" +
    ABRA_URL +
    ") fills: local secrets vault, npm " +
    ABRA_NPM +
    ", keys never touch .env.",
  guardrails: () =>
    "The 'rule in a config file is prose' point lands — a guardrail only exists if something enforces it, and the same is true for secrets. A .env is a convention; a vault is an enforcement point. abracadabra (" +
    ABRA_URL +
    ") makes the vault the enforcement point, locally.",
  identity: () =>
    "Key control across context resets is a real gap — most agents lose the credential and the identity at the same moment. The fix is keeping the private half out of the context window entirely, in a vault the agent re-reads each run. abracadabra (" +
    ABRA_URL +
    ") is a local secrets vault built for that pattern.",
};

// --- Decision ----------------------------------------------------------------
function decide(item) {
  const id = item.id;
  if (CURATED_DRAFTS[id]) return { action: "draft", ...CURATED_DRAFTS[id] };
  if (CURATED_SKIPS[id]) return { action: "skip", reason: REASONS[CURATED_SKIPS[id]] };
  const author = item.author || "unknown";
  if (OUR_AUTHORS.has(author)) return { action: "skip", reason: REASONS.own };
  if (TROLL_AUTHORS.has(author)) return { action: "skip", reason: REASONS.troll };
  if (FARM_AUTHORS.has(author)) return { action: "skip", reason: REASONS.farm };
  if (TUTORIAL_AUTHORS.has(author)) return { action: "skip", reason: REASONS.tutorial };
  if (ESSAY_AUTHORS.has(author)) return { action: "skip", reason: REASONS.essay };
  if (item.kind === "comment") return { action: "skip", reason: REASONS.meta };
  const pain = detectPain(item);
  if (pain && TEMPLATES[pain]) return { action: "draft", pain, draft: TEMPLATES[pain](item) };
  return { action: "skip", reason: REASONS.falsepos };
}

// --- IO ----------------------------------------------------------------------
function loadQueue() {
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
function saveQueue(q) {
  mkdirSync(dirname(QUEUE_FILE), { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2), "utf8");
}
function loadDrafts() {
  try {
    const d = JSON.parse(readFileSync(DRAFTS_FILE, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
function saveDrafts(d) {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  writeFileSync(DRAFTS_FILE, JSON.stringify(d, null, 2), "utf8");
}

const draftKey = (item) => `${item.postId || item.id}|${item.commentId || ""}`;

// --- Modes -------------------------------------------------------------------
function showDrafts() {
  const drafts = loadDrafts().filter((d) => d.status === "draft");
  if (asJson) {
    console.log(JSON.stringify({ type: "moltbook-reply", mode: "show", count: drafts.length, drafts }, null, 2));
    return;
  }
  if (drafts.length === 0) {
    console.log("[moltbook-reply] no pending drafts — run --run first, or everything is already reviewed");
    return;
  }
  console.log(`[moltbook-reply] ${drafts.length} pending draft${drafts.length === 1 ? "" : "s"} for review\n`);
  drafts.forEach((d, i) => {
    console.log(`--- ${i + 1}. ${d.author}${d.commentId ? " (comment)" : ""} ---`);
    console.log(`    url: ${d.url}`);
    console.log(`    why: ${d.why}`);
    console.log(`    draft: ${d.draft}\n`);
  });
  console.log(`Review + post manually, or edit drafts.json and re-run --show.`);
}

function runBatch() {
  const queue = loadQueue();
  const drafts = loadDrafts();
  const draftedKeys = new Set(drafts.map(draftKey));
  const pending = queue.filter((i) => !i.status && !draftedKeys.has(draftKey(i)));
  const batch = pending.slice(0, BATCH_CAP);
  const results = batch.map((item) => ({ item, decision: decide(item) }));

  const drafted = results.filter((r) => r.decision.action === "draft");
  const skipped = results.filter((r) => r.decision.action === "skip");

  if (mode === "dry-run") {
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            type: "moltbook-reply",
            mode: "dry-run",
            at: new Date().toISOString(),
            queued: queue.length,
            alreadyDrafted: queue.length - pending.length,
            batch: batch.length,
            drafted: drafted.map((r) => ({ id: r.item.id, author: r.item.author, pain: r.decision.pain })),
            skipped: skipped.map((r) => ({ id: r.item.id, author: r.item.author, reason: r.decision.reason })),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`[moltbook-reply] dry-run — ${queue.length} queued, ${batch.length} in next batch (cap ${BATCH_CAP})`);
    for (const r of results) {
      const tag = r.decision.action === "draft" ? "DRAFT" : "SKIP ";
      const detail = r.decision.action === "draft" ? r.decision.pain : r.decision.reason;
      console.log(`  ${tag}  ${r.item.id.slice(0, 8)}  ${(r.item.author || "?").padEnd(18)} ${detail}`);
    }
    console.log(`\nSummary: ${drafted.length} drafted, ${skipped.length} skipped (of first ${batch.length})`);
    console.log(`Nothing written. To write drafts + update queue: ./scripts/gotchibot moltbook reply --run`);
    return;
  }

  // --run
  const at = new Date().toISOString();
  const newDrafts = drafted.map((r) => ({
    postId: r.item.postId || r.item.id,
    commentId: r.item.commentId || null,
    author: r.item.author || "unknown",
    url: r.item.url,
    why: r.item.why || "",
    draft: r.decision.draft,
    status: "draft",
    draftedAt: at,
  }));
  const byId = new Map(results.map((r) => [r.item.id, r]));
  const updated = queue.map((item) => {
    const r = byId.get(item.id);
    if (!r) return item;
    if (r.decision.action === "draft") return { ...item, status: "drafted" };
    return { ...item, status: "skipped", skipReason: r.decision.reason };
  });
  // Consistency: any pending item that already has a draft (from an earlier
  // partial write) gets its queue status reconciled too.
  const finalQueue = updated.map((item) => {
    if (item.status) return item;
    if (draftedKeys.has(draftKey(item))) return { ...item, status: "drafted" };
    return item;
  });

  if (newDrafts.length) saveDrafts([...drafts, ...newDrafts]);
  saveQueue(finalQueue);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          type: "moltbook-reply",
          mode: "run",
          at,
          drafted: newDrafts.length,
          skipped: skipped.length,
          draftsFile: DRAFTS_FILE,
          remaining: finalQueue.filter((i) => !i.status).length,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`[moltbook-reply] wrote ${newDrafts.length} drafts to ${DRAFTS_FILE}`);
  console.log(`[moltbook-reply] marked ${skipped.length} skipped (with reason), ${finalQueue.filter((i) => !i.status).length} still pending`);
  console.log(`[moltbook-reply] review: ./scripts/gotchibot moltbook reply --show`);
}

function main() {
  if (mode === "show") {
    showDrafts();
    return;
  }
  runBatch();
}

main();