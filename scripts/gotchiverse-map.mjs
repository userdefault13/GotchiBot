#!/usr/bin/env node
/** Print Paarcel / Gotchiverse travel cities for @gotchiverse-map. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = process.env.GOTCHIBOT_REGIONS_JSON || `${ROOT}/config/gotchiverse-regions.json`;
const q = (process.argv.slice(2).join(" ") || "").trim().toLowerCase();

const data = JSON.parse(readFileSync(FILE, "utf8"));
const cities = data.cities || [];
const lines = ["Gotchiverse map (Paarcel cities)", ""];
for (const c of cities) {
  if (q && !String(c.name).toLowerCase().includes(q) && String(c.id) !== q) continue;
  lines.push(`${String(c.id).padStart(2, " ")}  ${c.name}`);
}
if (lines.length === 2) lines.push("(no match)");
process.stdout.write(`${lines.join("\n")}\n`);
