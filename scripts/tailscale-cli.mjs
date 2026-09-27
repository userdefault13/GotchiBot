/**
 * Tailscale CLI access for the Hub network setup.
 *
 * macOS GUI installs (App Store / standalone) ship the CLI inside the app bundle
 * and often leave nothing on PATH, so fall back to it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

let cachedBin;

export function tailscaleBin() {
  if (cachedBin !== undefined) return cachedBin;
  const r = spawnSync("tailscale", ["version"], { stdio: "ignore" });
  if (!r.error) cachedBin = "tailscale";
  else if (process.platform === "darwin" && existsSync(MAC_APP_CLI)) cachedBin = MAC_APP_CLI;
  else cachedBin = null;
  return cachedBin;
}

/** @returns {{ missing: boolean, json: object|null, err?: string }} */
export function readTailscaleStatus() {
  const bin = tailscaleBin();
  if (!bin) return { missing: true, json: null };
  const r = spawnSync(bin, ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  try {
    const json = JSON.parse(r.stdout || "");
    if (json && typeof json === "object" && json.BackendState) return { missing: false, json };
  } catch {
    /* daemon down prints text, not JSON */
  }
  return { missing: false, json: null, err: String(r.stderr || r.stdout || "").trim().slice(0, 200) };
}

const stripDot = (s) => (s ? String(s).replace(/\.$/, "") : null);

function loginOf(j) {
  const uid = j.Self?.UserID;
  if (uid == null || !j.User) return null;
  return j.User[String(uid)]?.LoginName ?? null;
}

/**
 * @param {{ missing: boolean, json: object|null, err?: string }} read
 * @returns {{ state: "missing"|"daemon-down"|"needs-login"|"needs-approval"|"stopped"|"starting"|"running",
 *   dnsName?: string|null, login?: string|null, tailnet?: string|null, backend?: string, err?: string }}
 */
export function tailscaleState(read) {
  if (read.missing) return { state: "missing" };
  const j = read.json;
  if (!j) return { state: "daemon-down", err: read.err };
  const base = {
    backend: j.BackendState,
    dnsName: stripDot(j.Self?.DNSName),
    login: loginOf(j),
    tailnet: j.CurrentTailnet?.Name ?? null,
  };
  switch (j.BackendState) {
    case "Running":
      return { state: "running", ...base };
    case "NeedsLogin":
    case "NoState":
      return { state: "needs-login", ...base };
    case "NeedsMachineAuth":
      return { state: "needs-approval", ...base };
    case "Stopped":
      return { state: "stopped", ...base };
    default:
      return { state: "starting", ...base };
  }
}

const PHONE_OS = new Set(["ios", "android"]);

/**
 * Online tailnet devices that could be running a Hub (this computer included).
 * @returns {{ name: string, dnsName: string|null, ip: string, os: string, self: boolean, sameUser: boolean }[]}
 */
export function hubProbeTargets(json) {
  const j = json && typeof json === "object" ? json : {};
  const selfUser = j.Self?.UserID;
  const nodes = [];
  if (j.Self) nodes.push({ ...j.Self, Online: true, self: true });
  for (const p of Object.values(j.Peer || {})) nodes.push({ ...p, self: false });
  return nodes
    .filter((n) => n.Online && Array.isArray(n.TailscaleIPs) && n.TailscaleIPs.length)
    .filter((n) => !PHONE_OS.has(String(n.OS || "").toLowerCase()))
    .map((n) => {
      const ip = n.TailscaleIPs.find((a) => a.includes(".")) || n.TailscaleIPs[0];
      return {
        name: n.HostName || stripDot(n.DNSName) || ip,
        dnsName: stripDot(n.DNSName),
        ip,
        os: n.OS || "",
        self: Boolean(n.self),
        sameUser: selfUser != null && n.UserID === selfUser,
      };
    });
}

export function tailscaleDownloadUrl(platform = process.platform) {
  if (platform === "darwin") return "https://tailscale.com/download/mac";
  if (platform === "win32") return "https://tailscale.com/download/windows";
  return "https://tailscale.com/download/linux";
}
