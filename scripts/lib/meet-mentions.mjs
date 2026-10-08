/**
 * @mention targets beyond the meeting's own members: every gotchi on the desk
 * roster (by name) and every hero seated in the current project (by template id,
 * speaking to its worker gotchi). The meet prompter offers them after "@"; the
 * meeting invites a mentioned gotchi who is not in the room yet.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchHeroes, currentProjectSlug } from "../project-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** "@Name" with only the characters a mention can hold (letters, digits, _ . -). */
export function mentionTag(name, id = "") {
  const clean = String(name || "").replace(/[^A-Za-z0-9_.-]+/g, "").replace(/^[._-]+/, "");
  return `@${clean || String(id)}`;
}

// Dots and dashes count: "User.Default" and "UserDefault" are different gotchis.
const norm = (s) => String(s || "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9._-]+/g, "").replace(/\.+$/, "");

/**
 * [{ tag, label, id, kind: "hero" | "gotchi" }]: seated heroes first (their tag
 * is the template id, their id the worker gotchi), then roster gotchis by name.
 * Tags are unique; a clash gets the gotchi id appended.
 */
export function deskMentionTargets({ root = ROOT, slug = currentProjectSlug() } = {}) {
  let roster = null;
  try {
    roster = JSON.parse(readFileSync(join(root, "sessions", ".avatar-roster.json"), "utf8"));
  } catch {
    roster = null;
  }
  const names = new Map();
  if (roster?.pinned) names.set(roster.pinned, roster.pinnedName || roster.pinned);
  for (const o of roster?.others || []) {
    if (o?.id && !String(o.id).startsWith("hero:")) names.set(o.id, o.name || o.id);
  }
  const out = [];
  const seen = new Set();
  const push = (t) => {
    let tag = t.tag;
    if (seen.has(tag.toLowerCase())) tag = `${tag}-${t.id}`;
    seen.add(tag.toLowerCase());
    out.push({ ...t, tag });
  };
  try {
    if (slug) {
      for (const h of benchHeroes(slug)) {
        if (!h.worker || h.hero === "orchestrator") continue;
        push({ tag: `@${h.hero}`, label: `${h.hero.replace(/-/g, " ")} · ${names.get(h.worker) || h.worker}`, id: h.worker, kind: "hero" });
      }
    }
  } catch {
    /* no workbench */
  }
  for (const [id, name] of names) push({ tag: mentionTag(name, id), label: name, id, kind: "gotchi" });
  return out;
}

/** The gotchi id a mention token names (a hero tag, a roster name, or an id), or null. */
export function resolveDeskMention(token, targets = deskMentionTargets()) {
  const t = norm(token);
  if (!t) return null;
  const hit =
    targets.find((x) => norm(x.tag) === t) ||
    targets.find((x) => norm(x.id) === t) ||
    targets.find((x) => x.kind === "gotchi" && norm(x.label) === t);
  return hit?.id || null;
}
