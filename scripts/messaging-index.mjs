#!/usr/bin/env node
/**
 * Messaging index — which channel for what.
 *   node scripts/messaging-index.mjs [--json] [--text] [--channel bot-inbox|passoff|meet|agentmail]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "config", "messaging-index.json");
const args = process.argv.slice(2);
const data = JSON.parse(readFileSync(INDEX, "utf8"));
const ch = args.includes("--channel") ? args[args.indexOf("--channel") + 1] : "";
const wantText = args.includes("--text") || Boolean(ch);
const wantJson = args.includes("--json") || !wantText;

if (ch) {
  const hit = (data.channels || []).find((c) => c.id === ch);
  if (!hit) {
    console.error(`unknown channel "${ch}". have: ${(data.channels || []).map((c) => c.id).join(", ")}`);
    process.exit(2);
  }
  console.log(JSON.stringify(hit, null, 2));
  process.exit(0);
}

if (wantJson && !args.includes("--text")) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

console.log(`# ${data.title} v${data.version}`);
console.log(data.summary);
if (data.policy) {
  console.log("\nHard policy:");
  console.log(`  agent↔agent: ${data.policy.agentToAgent}`);
  console.log(`  external in:  ${data.policy.externalMailIn}`);
  console.log(`  external out: ${data.policy.externalMailOut}`);
  for (const a of data.policy.anti || []) console.log(`  anti: ${a}`);
}
console.log("\nChannels:");
for (const c of data.channels || []) {
  console.log(`  - ${c.id} [${c.kind}] owner=${c.owner}`);
  console.log(`      use: ${(c.useFor || []).slice(0, 3).join("; ")}`);
}
console.log("\nRouting:");
for (const r of data.routingTable || []) {
  console.log(`  want: ${r.want}`);
  console.log(`    → ${r.use}`);
}
console.log("\nDeep: node ./scripts/messaging-index.mjs --channel <id>");
process.exit(0);
