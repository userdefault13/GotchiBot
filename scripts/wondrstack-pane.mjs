#!/usr/bin/env node
/**
 * WondrStack pane: link state, Connect (device-code sign-in), Disconnect.
 * A human terminal UI over the device-link library in wondrstack.mjs (imported,
 * never shelled out). Chrome and palette come from the dossier pane (pstack-window).
 * Tokens never reach this file: the library stores them in abra and reports only events.
 *
 *   gotchibot wondrstack pane [--project gotchibot]
 *   Cockpit: Ctrl+Space, Shift+K → Desk panes… → WondrStack
 *
 * Keys: c connect · d disconnect · y/n confirm · o open link · q/esc back
 */
import readline from "node:readline";
import { c, boxTop, boxMid, boxRow, boxBottom, padVis } from "./pstack-window.mjs";
import { DEVICE_WARNING, abraStore, deviceConfig, deviceLink, disconnect, linkState, openBrowser } from "./wondrstack.mjs";

export function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The short code, spaced and bold in a box so it reads from across the room. */
function codeBlock(code, innerW) {
  const big = String(code).split("").join(" ");
  const lead = " ".repeat(Math.max(0, Math.floor((innerW - big.length) / 2)));
  return ["", `${lead}${c.gold}${c.bold}${big}${c.reset}`, ""];
}

/**
 * Pure render of one view. view.name: home | confirm | waiting | approved | denied | expired |
 * cancelled | error | disconnect-confirm | disconnected. Returns lines (strings with ANSI).
 */
export function renderView(view, { cols = 72, now = Date.now() } = {}) {
  const innerW = Math.max(20, cols - 2);
  const kv = (k, v) => `  ${c.dim}${padVis(k, 10)}${c.reset}${v}`;
  const note = (t) => `  ${t}`;
  const out = [boxTop("WONDRSTACK", innerW)];
  const hint = (t) => `${c.dim}${t}${c.reset}`;
  const project = view.project || "gotchibot";
  switch (view.name) {
    case "home": {
      const st = view.state || {};
      out.push(boxRow(kv("project", project), innerW));
      if (st.error) {
        out.push(boxRow(kv("state", `${c.yellow}unknown${c.reset}`), innerW));
        out.push(boxRow(note(`${c.yellow}Could not read the vault: ${st.error}${c.reset}`), innerW));
      } else if (st.linked) {
        out.push(boxRow(kv("state", `${c.green}linked${c.reset}`), innerW));
        out.push(boxRow(note(`${c.dim}Sign-in is stored in abra. Tokens are never shown.${c.reset}`), innerW));
      } else {
        out.push(boxRow(kv("state", `${c.orange}not linked${c.reset}`), innerW));
        out.push(boxRow(note(`${c.dim}Connect to let GotchiBot use WondrStack for ${project}.${c.reset}`), innerW));
      }
      if (view.notice) out.push(boxRow(note(`${c.yellow}${view.notice}${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint(st.linked ? "d disconnect · q back" : "c connect · q back"));
      break;
    }
    case "confirm":
      out.push(boxMid("CONNECT", innerW));
      out.push(boxRow(note(`${c.orange}${c.bold}Read this first.${c.reset}`), innerW));
      out.push(boxRow(note("Approval grants the FULL `wondrstack` scope, including the"), innerW));
      out.push(boxRow(note("deploy, delete and spend tools. There is no read-only scope yet."), innerW));
      out.push(boxRow(note(`${c.dim}GotchiBot will still ask you before it deploys, deletes or spends.${c.reset}`), innerW));
      out.push(boxRow("", innerW));
      out.push(boxRow(note(`Connect ${c.bold}${project}${c.reset} to WondrStack?`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("y yes, start · n no, go back"));
      break;
    case "starting":
      out.push(boxRow(note(`${c.dim}Asking WondrStack for a sign-in code…${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("q cancel"));
      break;
    case "waiting": {
      const w = view.wait;
      out.push(boxMid("APPROVE IN YOUR BROWSER", innerW));
      out.push(boxRow(note(`Open  ${c.cyan}${w.link}${c.reset}`), innerW));
      if (w.completeLink) out.push(boxRow(note(`${c.dim}or    ${w.completeLink}${c.reset}`), innerW));
      out.push(boxRow("", innerW));
      out.push(boxRow(note("Your code:"), innerW));
      for (const l of codeBlock(w.userCode, innerW)) out.push(boxRow(l, innerW));
      out.push(boxRow(note(`${c.bold}Confirm the code on the page matches this one.${c.reset}`), innerW));
      out.push(boxRow(note("If it differs, do not approve."), innerW));
      out.push(boxRow("", innerW));
      out.push(boxRow(note(`${c.yellow}Waiting for approval…${c.reset}  expires in ${c.gold}${fmtCountdown(w.expiresAt - now)}${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("o open link · q cancel"));
      break;
    }
    case "approved":
      out.push(boxRow(note(`${c.green}${c.bold}Connected.${c.reset} WondrStack is linked for ${project}.`), innerW));
      out.push(boxRow(note(`${c.dim}Sign-in saved to abra. Tokens are not shown.${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    case "denied":
      out.push(boxRow(note(`${c.orange}${c.bold}Not approved.${c.reset} The approval was refused, so nothing was connected.`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    case "expired":
      out.push(boxRow(note(`${c.orange}${c.bold}The code expired${c.reset} before it was approved. Nothing was connected.`), innerW));
      out.push(boxRow(note(`${c.dim}Press c on the next screen to try again.${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    case "cancelled":
      out.push(boxRow(note("Cancelled. Nothing was connected."), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    case "error":
      out.push(boxRow(note(`${c.orange}${c.bold}Could not connect.${c.reset}`), innerW));
      out.push(boxRow(note(`${c.yellow}${view.message}${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    case "disconnect-confirm":
      out.push(boxMid("DISCONNECT", innerW));
      out.push(boxRow(note(`Remove the WondrStack sign-in for ${c.bold}${project}${c.reset} from abra?`), innerW));
      out.push(boxRow(note(`${c.yellow}WondrStack revocation is not supported by this client:${c.reset}`), innerW));
      out.push(boxRow(note("only the stored tokens are deleted here. The grant stays active"), innerW));
      out.push(boxRow(note("on wondrstack.xyz until you revoke it there."), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("y yes, remove tokens · n no, go back"));
      break;
    case "disconnected":
      out.push(boxRow(note(view.removed ? "Removed the stored WondrStack sign-in from abra." : "There was no stored sign-in to remove."), innerW));
      out.push(boxRow(note(`${c.dim}Not revoked on WondrStack's side. Revoke it on wondrstack.xyz if needed.${c.reset}`), innerW));
      out.push(boxBottom(innerW));
      out.push(hint("any key to continue"));
      break;
    default:
      out.push(boxBottom(innerW));
  }
  return out;
}

/**
 * The controller. deps: { project, store, config, cache, fetchFn, now, sleep, open, draw(lines), readKey(): Promise<string>,
 * tick(fn, ms) -> stop, withCooked(fn) }. Keys are names: "c","d","y","n","o","q","escape","enter",...
 * Resolves when the owner leaves the pane.
 */
export async function runPane(deps) {
  const { project = "gotchibot", store = abraStore, now = Date.now, draw, readKey } = deps;
  const open = deps.open || ((u) => { if (/^https:\/\//.test(u)) openBrowser(u); });
  const tick = deps.tick || ((fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); });
  const cooked = deps.withCooked || ((fn) => fn());
  const show = (view) => draw(renderView({ project, ...view }, { now: now() }));
  const isBack = (k) => k === "q" || k === "escape";
  let notice = "";
  for (;;) {
    const state = await cooked(() => linkState(project, { store }));
    show({ name: "home", state, notice });
    notice = "";
    const k = await readKey();
    if (isBack(k)) return;
    if (k === "c" && !state.linked && !state.error) {
      show({ name: "confirm" });
      if ((await readKey()) !== "y") continue;
      await connect();
    } else if (k === "d" && state.linked) {
      show({ name: "disconnect-confirm" });
      if ((await readKey()) !== "y") continue;
      try {
        const r = await cooked(() => disconnect(project, { store }));
        show({ name: "disconnected", removed: r.removed });
      } catch (e) {
        show({ name: "error", message: String(e?.message || e) });
      }
      await readKey();
    }
  }

  async function connect() {
    show({ name: "starting" });
    const ac = new AbortController();
    let wait = null;
    let stopTick = () => {};
    const redraw = () => wait && show({ name: "waiting", wait });
    const link = deviceLink(project, {
      config: deps.config || deviceConfig(),
      cache: deps.cache,
      store,
      fetchFn: deps.fetchFn,
      sleep: deps.sleep,
      now,
      signal: ac.signal,
      log: () => {},
      onEvent: (ev) => {
        if (ev.type === "started") {
          wait = ev;
          redraw();
          stopTick = tick(redraw, 1000);
        }
      },
    }).then((r) => ({ r }), (e) => ({ e }));
    let done = null;
    let keyPromise = null;
    while (!done) {
      keyPromise ||= readKey().then((k) => ({ k }));
      const got = await Promise.race([link.then((x) => ({ done: x })), keyPromise]);
      if (got.done) {
        done = got.done;
        break;
      }
      keyPromise = null;
      if (got.k === "o" && wait) open(wait.completeLink || wait.link);
      else if (isBack(got.k)) ac.abort();
    }
    stopTick();
    // A key read still pending must not eat the next screen's key: resolved by the caller's readKey queue.
    const res = done;
    if (res.r) show({ name: "approved" });
    else if (res.e.kind === "denied") show({ name: "denied" });
    else if (res.e.kind === "expired") show({ name: "expired" });
    else if (res.e.kind === "cancelled") show({ name: "cancelled" });
    else show({ name: "error", message: String(res.e.message || res.e) });
    if (keyPromise) await keyPromise;
    else await readKey();
  }
}

/** Real terminal: raw keys, alternate-screen-free redraw, abra/IO as configured. */
export async function runRealPane(project = "gotchibot") {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY) {
    console.error("wondrstack pane needs a terminal");
    return 1;
  }
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const queue = [];
  let waiter = null;
  const onKey = (str, key) => {
    if (key?.ctrl && key.name === "c") {
      cleanup();
      process.exit(130);
    }
    const name = key?.name === "escape" ? "escape" : key?.name === "return" ? "enter" : String(str || key?.name || "").toLowerCase();
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(name);
    } else queue.push(name);
  };
  input.on("keypress", onKey);
  const cleanup = () => {
    input.off("keypress", onKey);
    try { input.setRawMode(false); } catch {}
    input.pause();
  };
  try {
    await runPane({
      project,
      draw: (lines) => output.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`),
      readKey: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => { waiter = r; })),
      withCooked: (fn) => {
        // abra may ask to approve a read on the tty: give it the terminal back.
        input.off("keypress", onKey);
        input.setRawMode(false);
        try { return fn(); } finally { input.setRawMode(true); input.on("keypress", onKey); }
      },
    });
  } finally {
    cleanup();
  }
  return 0;
}
