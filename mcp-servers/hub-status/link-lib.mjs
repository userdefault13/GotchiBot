/**
 * WondrStack device-link tools for the hub-status MCP server (start / wait style).
 *
 * These two are NOT read-only monitors: start asks WondrStack for a sign-in code and saves a
 * 0600 pending file under sessions/wondrstack/; wait stores tokens in abra on approval. They
 * never auto-run, start refuses without confirm_full_scope: true, and no output carries a
 * device_code or token. The owner approves in a browser; the agent only relays the code.
 */
const PROJECT = /^[a-z0-9][a-z0-9-]{0,40}$/;

export async function wondrstackLink(name, args = {}, lib) {
  const a = args && typeof args === "object" ? args : {};
  const wl = lib || (await import("../../scripts/wondrstack.mjs"));
  const project = a.project == null || a.project === "" ? wl.defaultLinkProject() : String(a.project);
  if (!PROJECT.test(project)) return { ok: false, status: "failed", kind: "error", message: "project must be a lowercase slug" };
  if (name === "wondrstack_link_start") return wl.deviceStart(project, { confirmFullScope: a.confirm_full_scope === true });
  const secs = Math.min(55, Math.max(1, Number(a.timeout_seconds) || 50));
  return wl.deviceWait(project, { timeoutMs: secs * 1000 });
}
