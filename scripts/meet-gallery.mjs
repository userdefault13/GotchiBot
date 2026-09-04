#!/usr/bin/env node
/**
 * Meeting gallery tile list for tmux layout.
 *
 *   node scripts/meet-gallery.mjs [--json|--shell]
 *
 * Tiles = chair + agents (exclude user). Cap 4; if more, last tile is overflow.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEETINGS = `${ROOT}/sessions/meetings`;
const MAX_TILES = Math.max(1, Number(process.env.GOTCHIBOT_MEET_GALLERY_MAX || 4) || 4);

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function meetingPath(id) {
  return `${MEETINGS}/${id}/meeting.json`;
}

function loadCurrentMeeting() {
  if (!existsSync(`${MEETINGS}/.current`)) return null;
  const id = String(readFileSync(`${MEETINGS}/.current`, "utf8")).trim();
  if (!id) return null;
  const meeting = readJson(meetingPath(id), null);
  if (!meeting || meeting.status !== "open") return null;
  return meeting;
}

function shortLabel(p) {
  const name = String(p?.name || "").trim();
  if (name && name.length <= 16) return name;
  const id = String(p?.id || "");
  const m = id.match(/starter-([a-z0-9]+)-/i) || id.match(/owned-(\d+)/i);
  if (m) return m[1].toUpperCase();
  if (id.length <= 14) return id;
  return `${id.slice(0, 12)}…`;
}

function orchFallback() {
  const ob = readJson(`${ROOT}/sessions/.onboarding.json`, {});
  const id = ob.orchestratorHeroId || "owned-954";
  return [{ id, label: shortLabel({ id, name: "chair" }), role: "chair", kind: "hero" }];
}

export function listGalleryTiles(meeting = loadCurrentMeeting()) {
  const parts = (meeting?.participants || []).filter((p) => p && p.role !== "user");
  if (!parts.length) {
    return {
      meetingId: meeting?.id || null,
      max: MAX_TILES,
      tiles: orchFallback(),
      overflow: [],
    };
  }

  const heroes = parts.map((p) => ({
    id: p.id,
    label: shortLabel(p),
    role: p.role || "agent",
    kind: "hero",
  }));

  if (heroes.length <= MAX_TILES) {
    return { meetingId: meeting?.id || null, max: MAX_TILES, tiles: heroes, overflow: [] };
  }

  const shown = heroes.slice(0, MAX_TILES - 1);
  const overflow = heroes.slice(MAX_TILES - 1);
  shown.push({
    id: "__more__",
    label: `+${overflow.length} more`,
    role: "overflow",
    kind: "more",
    moreIds: overflow.map((h) => h.id),
    moreLabels: overflow.map((h) => h.label),
  });
  return { meetingId: meeting?.id || null, max: MAX_TILES, tiles: shown, overflow };
}

function main() {
  const json = process.argv.includes("--json");
  const data = listGalleryTiles();
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  // shell-friendly: KIND\tID\tLABEL[\tmoreIds comma]
  for (const t of data.tiles) {
    if (t.kind === "more") {
      console.log(`more\t${t.id}\t${t.label}\t${(t.moreIds || []).join(",")}`);
    } else {
      console.log(`hero\t${t.id}\t${t.label}\t`);
    }
  }
}


if (isMainModule(import.meta.url)) main();
