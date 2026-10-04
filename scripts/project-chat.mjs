#!/usr/bin/env node
/**
 * Per-project Gotchi chat pins.
 *
 * sessions/.opencode-agent-sessions.json used to store one `project` session
 * for the whole desk, so opening another project resumed the previous
 * transcript. Pins now live under `projects[<slug>]`. An unscoped legacy pin
 * belongs only to `legacySlug` (the project that was current when the pin was
 * global) and is never handed to a different project.
 *
 *   node scripts/project-chat.mjs id
 *   node scripts/project-chat.mjs remember ses_…
 *   node scripts/project-chat.mjs claim
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { currentProjectSlug } from "./project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHAT_PIN_FILE = `${ROOT}/sessions/.opencode-agent-sessions.json`;

export function sessionIdOk(id) {
  return typeof id === "string" && /^ses_[A-Za-z0-9]+$/.test(id);
}

/** Session for this project only. Missing pin → "" (start empty). */
export function chatSessionFor(map, slug) {
  const m = map && typeof map === "object" ? map : {};
  if (!slug) return "";
  if (m.projects && Object.prototype.hasOwnProperty.call(m.projects, slug)) {
    const id = m.projects[slug]?.sessionId || "";
    return sessionIdOk(id) ? id : "";
  }
  if (m.legacySlug && slug === m.legacySlug) {
    const id = m.project?.sessionId || m.gotchi?.sessionId || "";
    return sessionIdOk(id) ? id : "";
  }
  return "";
}

/** Remember `sessionId` for `slug` without touching any other project's pin. */
export function rememberChatSession(map, slug, sessionId, now = new Date().toISOString()) {
  const m = map && typeof map === "object" ? { ...map } : {};
  m.projects = { ...(m.projects || {}) };
  if (!slug || !sessionIdOk(sessionId)) return m;
  const row = { sessionId, updatedAt: now };
  m.projects[slug] = row;
  if (m.legacySlug && slug === m.legacySlug) {
    m.project = row;
    m.gotchi = { ...(m.gotchi || {}), ...row };
  }
  return m;
}

/**
 * Bind an unscoped `project` / `gotchi` pin to one slug, once.
 * Later projects do not inherit it.
 */
export function claimLegacyChat(map, slug) {
  const m = map && typeof map === "object" ? { ...map } : {};
  m.projects = { ...(m.projects || {}) };
  if (!slug || m.legacySlug) return m;
  m.legacySlug = slug;
  const id = m.project?.sessionId || m.gotchi?.sessionId || "";
  if (sessionIdOk(id) && !Object.prototype.hasOwnProperty.call(m.projects, slug)) {
    m.projects[slug] = {
      sessionId: id,
      updatedAt: m.project?.updatedAt || m.gotchi?.updatedAt || null,
    };
  }
  return m;
}

export function loadChatMap(path = CHAT_PIN_FILE) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function saveChatMap(map, path = CHAT_PIN_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
}

function main() {
  const cmd = process.argv[2] || "id";
  const slug = currentProjectSlug();
  let map = loadChatMap();
  if (!map.legacySlug && slug) {
    map = claimLegacyChat(map, slug);
    saveChatMap(map);
  }
  if (cmd === "id") {
    process.stdout.write(chatSessionFor(map, slug));
    return;
  }
  if (cmd === "claim") {
    process.stdout.write(map.legacySlug || "");
    return;
  }
  if (cmd === "remember") {
    const id = process.argv[3] || "";
    if (!slug || !sessionIdOk(id)) process.exit(0);
    saveChatMap(rememberChatSession(map, slug, id));
    return;
  }
  console.error("usage: project-chat.mjs id | claim | remember <ses_…>");
  process.exit(2);
}

if (isMainModule(import.meta.url)) main();
