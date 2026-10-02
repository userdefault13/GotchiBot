/**
 * Find a desk pane by the command that started it.
 * Pane indexes move (3-pane chat is work.1, 7-pane chat is work.3).
 */
import { spawnSync } from "node:child_process";

export function sessionName() {
  return String(process.env.GOTCHIBOT_TMUX_SESSION || "gotchibot").replace(/^=/, "");
}

export function paneByCommand(sess, pattern) {
  const r = spawnSync(
    "tmux",
    ["list-panes", "-t", `${sess}:work`, "-F", "#{pane_index} #{pane_start_command}"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  for (const line of String(r.stdout || "").split("\n")) {
    if (!line.includes(pattern)) continue;
    const idx = line.trim().split(/\s+/)[0];
    if (/^\d+$/.test(idx)) return `${sess}:work.${idx}`;
  }
  return null;
}

export function paneCount(sess) {
  const r = spawnSync("tmux", ["list-panes", "-t", `${sess}:work`, "-F", "#{pane_index}"], {
    encoding: "utf8",
  });
  if (r.status !== 0) return 0;
  return String(r.stdout || "").split("\n").filter(Boolean).length;
}

/** Chat slot: live chat-pane, else the collapsed chat bar, else the legacy index. */
export function chatPaneTarget(sess = sessionName()) {
  return (
    paneByCommand(sess, "chat-pane.sh") ||
    paneByCommand(sess, "chat-bar-pane.sh") ||
    (paneCount(sess) >= 7 ? `${sess}:work.3` : `${sess}:work.1`)
  );
}
