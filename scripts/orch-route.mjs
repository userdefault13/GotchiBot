#!/usr/bin/env node
/**
 * Where an orchestrator message goes: a role desk, a worker, or the orch itself.
 *
 *   node scripts/orch-route.mjs "prompt" [--json]
 *
 * stdout: architect | worker | self   (--json adds why + the seated hero)
 *
 * Rules: config/orch-routes.json. Role → hero: config/agent-roles.json.
 * Enforced per turn by .opencode/plugins/gotchi-orch-route.js.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function compile(list) {
  return (list || []).flatMap((src) => {
    try {
      return [new RegExp(src, "i")];
    } catch {
      return [];
    }
  });
}

export function loadRoutes(root = ROOT) {
  const cfg = readJson(`${root}/config/orch-routes.json`, {});
  return {
    optOut: compile(cfg.optOut),
    self: compile(cfg.self),
    routes: (cfg.routes || []).map((r) => ({ to: r.to, why: r.why || r.to, match: compile(r.match) })),
  };
}

/** First hero seated in a role, never the orchestrator seat. */
export function heroForRole(role, root = ROOT) {
  const roles = readJson(`${root}/config/agent-roles.json`, {});
  return Object.keys(roles).find((id) => roles[id] === role && roles[id] !== "orchestrator") || null;
}

export function classifyOrchRoute(prompt, { root = ROOT } = {}) {
  const text = String(prompt || "").trim();
  if (!text) return { route: "self", why: "empty" };
  const cfg = loadRoutes(root);
  if (cfg.optOut.some((re) => re.test(text))) return { route: "self", why: "UserDefault said answer it yourself" };
  if (cfg.self.some((re) => re.test(text))) return { route: "self", why: "chit-chat / status / command" };
  for (const r of cfg.routes) {
    if (!r.match.some((re) => re.test(text))) continue;
    if (r.to === "worker") return { route: "worker", why: r.why };
    const hero = heroForRole(r.to, root);
    if (hero) return { route: r.to, why: r.why, hero };
  }
  return { route: "self", why: "no route matched" };
}

if (isMainModule(import.meta.url)) {
  const json = process.argv.includes("--json");
  const prompt = process.argv.slice(2).filter((a) => a !== "--json").join(" ");
  const r = classifyOrchRoute(prompt);
  console.log(json ? JSON.stringify(r) : r.route);
}
