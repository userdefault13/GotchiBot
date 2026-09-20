#!/usr/bin/env node
/**
 * Prof. Link-Cube template TOC — real sources only.
 * Sources (in order, merged by id):
 *   1) templates/marketplace/catalog.json (from `gotchibot templates pack` / list)
 *   2) templates/marketplace/packs/<id>/pack.json
 *   3) config/agent-role-playbooks.json keys (playbook roles)
 *
 * Usage:
 *   node scripts/prof-toc.mjs [--json] [--text]
 * Exit 0 with non-empty TOC, 2 if empty.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.GOTCHIBOT_ROOT?.trim() || join(__dirname, "..");
const MARKET = join(ROOT, "templates", "marketplace");
const PACKS = join(MARKET, "packs");
const CATALOG = join(MARKET, "catalog.json");
const PLAYBOOKS = join(ROOT, "config", "agent-role-playbooks.json");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** @returns {Map<string, object>} */
function collect() {
  const byId = new Map();

  const catalog = readJson(CATALOG);
  if (catalog?.packs && Array.isArray(catalog.packs)) {
    for (const p of catalog.packs) {
      const id = String(p.id || p.roleId || "").trim();
      if (!id) continue;
      byId.set(id, {
        id,
        title: String(p.title || id),
        summary: String(p.summary || ""),
        version: p.version ? String(p.version) : undefined,
        tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
        source: "catalog",
      });
    }
  }

  if (existsSync(PACKS)) {
    for (const name of readdirSync(PACKS, { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const packPath = join(PACKS, name.name, "pack.json");
      const playbookPath = join(PACKS, name.name, "playbook.json");
      const pack = readJson(packPath) || {};
      const playbook = readJson(playbookPath) || {};
      const id = String(pack.id || pack.roleId || name.name).trim();
      if (!id) continue;
      const prev = byId.get(id);
      byId.set(id, {
        id,
        title: String(pack.title || playbook.title || prev?.title || id),
        summary: String(pack.summary || playbook.summary || prev?.summary || ""),
        version: pack.version ? String(pack.version) : prev?.version,
        tags: Array.isArray(pack.tags) ? pack.tags.map(String) : prev?.tags,
        source: prev ? `${prev.source}+pack` : "pack",
      });
    }
  }

  const pb = readJson(PLAYBOOKS);
  if (pb && typeof pb === "object") {
    for (const [key, val] of Object.entries(pb)) {
      if (!val || typeof val !== "object") continue;
      const id = String(key).trim();
      if (!id) continue;
      if (byId.has(id)) {
        const cur = byId.get(id);
        if (!cur.summary && val.summary) cur.summary = String(val.summary);
        if (!cur.title && val.title) cur.title = String(val.title);
        cur.source = `${cur.source}+playbook`;
        continue;
      }
      byId.set(id, {
        id,
        title: String(val.title || id),
        summary: String(val.summary || ""),
        source: "playbook",
      });
    }
  }

  return byId;
}

const entries = [...collect().values()].sort((a, b) => a.id.localeCompare(b.id));
const wantJson = process.argv.includes("--json") || !process.argv.includes("--text");

if (wantJson) {
  console.log(JSON.stringify({ root: ROOT, count: entries.length, packs: entries }, null, 2));
} else {
  console.log(`Prof. Link-Cube templates — ${entries.length} pack(s)/playbook(s)`);
  for (const e of entries) {
    const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
    console.log(`- ${e.id}: ${e.title}${tags}`);
    if (e.summary) console.log(`    ${e.summary.slice(0, 120)}`);
  }
}

if (entries.length === 0) process.exit(2);
