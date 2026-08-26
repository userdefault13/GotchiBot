#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const endpoints = JSON.parse(readFileSync(`${ROOT}/config/subgraph.endpoints.json`, "utf8"));
const CORE = endpoints.subgraphs["aavegotchi-core-base"].url;
const SVG = endpoints.subgraphs["aavegotchi-svg-base"].url;

const COLLATERAL_COLORS = {
  "0x403e387d4cf9a5aede32b6ca08f4c413ef626554": "#787773",
  "0x6f38e46232dc1ea452d7ce76477ed0cd33ee25af": "#ff7276",
  "0x049583cdbafb4eca84296372fbec1cf10785de82": "#71e2a6",
  "0xa6fa4fb5f33b24346593ba18b7fb62a77efe366e": "#ffffff",
  "0x15bb5062553ee2a2560830c03593421f59d7ff8c": "#f90e84",
};

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token") args.token = argv[++i];
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.token && !args.file) {
    console.error("usage: fetch-gotchi-svg.mjs --token <id> | --file <identity.json> [--out <path>]");
    process.exit(2);
  }
  return args;
}

async function gql(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`subgraph ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

async function coreGotchi(id) {
  const data = await gql(CORE, `{
    aavegotchis(first: 1, where: { gotchiId: "${id}" }) {
      gotchiId name collateral numericTraits modifiedNumericTraits
      equippedWearables eyeShape eyeColor
    }
  }`);
  return data.aavegotchis[0] ?? null;
}

async function svgGotchi(id) {
  try {
    const data = await gql(SVG, `{
      aavegotchis(first: 1, where: { gotchiId: "${id}" }) { svg }
    }`);
    return data.aavegotchis[0]?.svg || "";
  } catch {
    return "";
  }
}

function placeholderSvg(g) {
  const traits = g?.numericTraits ?? [50, 50, 50, 50, 50, 50];
  const eyeColor =
    g?.eyeColor != null ? ["#000000", "#ffffff", "#00ffe2", "#ffb011", "#00a3ff"][g.eyeColor % 5] : "#000000";
  const collateral = (g?.collateral ?? "").toLowerCase();
  const body = COLLATERAL_COLORS[collateral] ?? "#eeeeee";
  const energy = Math.max(20, Math.min(80, traits[1] ?? 50));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#1a1826"/>
<path d="M12 ${12 + ((100 - energy) / 100) * 10} h40 v30 q-10 14 -20 14 t-20 -14 z" fill="${body}" stroke="#000" stroke-width="1.5"/>
<path d="M16 60 q16 -8 32 0" fill="#1a1826"/>
<circle cx="24" cy="28" r="4" fill="#fff"/><circle cx="40" cy="28" r="4" fill="#fff"/>
<circle cx="24" cy="28" r="1.8" fill="${eyeColor}"/><circle cx="40" cy="28" r="1.8" fill="${eyeColor}"/>
</svg>`;
}

const args = parseArgs(process.argv.slice(2));

let svg = "";
let meta = {};

if (args.file) {
  const doc = JSON.parse(readFileSync(args.file, "utf8"));
  svg = doc.svg ?? "";
  meta = { source: "identity-doc", role: doc.role ?? "agent", id: doc.id ?? "" };
} else {
  const g = await coreGotchi(args.token);
  if (!g) {
    console.error(`no gotchi found for token ${args.token}`);
    process.exit(1);
  }
  svg = await svgGotchi(args.token);
  meta = { source: svg ? "svg-subgraph" : "placeholder", gotchiId: g.gotchiId, name: g.name };
  if (!svg) svg = placeholderSvg(g);
}

if (!svg.trim()) {
  console.error("no SVG in identity document");
  process.exit(1);
}
if (!svg.startsWith("<svg") && !svg.startsWith("<?xml")) {
  svg = `<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
}

const outPath = args.out ?? `${ROOT}/sessions/.avatars/${meta.gotchiId ?? Date.now()}.svg`;
if (!args.out) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg);
console.log(JSON.stringify({ ...meta, out: outPath }));
