#!/usr/bin/env node
/**
 * Worker index — tools + deep lanes (dispatch / skill-requests / desk-terminals).
 *   node scripts/worker-index.mjs [--json] [--text] [--lane dispatch-io|skill-requests|desk-terminals]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GOTCHIBOT_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "config", "worker-index.json");
const args = process.argv.slice(2);
const data = JSON.parse(readFileSync(INDEX, "utf8"));
const laneFlag = args.includes("--lane") ? args[args.indexOf("--lane") + 1] : "";
const wantText = args.includes("--text") || Boolean(laneFlag);
const wantJson = args.includes("--json") || (!wantText && !laneFlag);

if (laneFlag) {
  const lane = data.lanes?.[laneFlag];
  if (!lane) {
    console.error(`unknown lane "${laneFlag}". have: ${Object.keys(data.lanes || {}).join(", ")}`);
    process.exit(2);
  }
  if (args.includes("--json") || !args.includes("--text")) {
    console.log(JSON.stringify(lane, null, 2));
  } else {
    console.log(JSON.stringify(lane, null, 2));
  }
  process.exit(0);
}

if (wantJson && !args.includes("--text")) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

console.log(`# ${data.title} (${data.roleId}) v${data.version}`);
console.log(data.summary);
console.log("\nSeat:");
console.log(`  ${data.seat.apply}`);
console.log(`  ${data.seat.resummon}`);
console.log("\nTools:");
for (const t of data.tools) {
  const inv = t.invoke || (t.paths ? t.paths.join(", ") : "");
  console.log(`  - ${t.id} [${t.lane}] ${inv}`);
  if (t.when) console.log(`      when: ${t.when}`);
}
if (data.deepLanes?.length) {
  console.log("\nDeep lanes (node ./scripts/worker-index.mjs --lane <id> --json):");
  for (const id of data.deepLanes) console.log(`  - ${id}`);
}
console.log("\nAnti-jobs:");
for (const a of data.antiJobs || []) console.log(`  - ${a}`);
console.log("\nRequest flow:");
(data.requestFlow || []).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
process.exit(0);
