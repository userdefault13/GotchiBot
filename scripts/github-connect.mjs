#!/usr/bin/env node
/**
 * Connect GotchiBot to GitHub — one personal access token in abra
 * (project gotchibot, key GOTCHIBOT_GITHUB_PAT), read by scripts/mcp/github.sh.
 *
 *   node scripts/github-connect.mjs status [--json] [--live]
 *   node scripts/github-connect.mjs connect-gh      # reuse the gh CLI login
 *   node scripts/github-connect.mjs connect-token   # hidden abra prompt for a PAT
 *   node scripts/github-connect.mjs verify          # who does the stored token belong to
 *   node scripts/github-connect.mjs repos [--json]  # latest-pushed repos (gh login, else abra token)
 *   node scripts/github-connect.mjs disconnect
 *
 * The token value never touches disk outside abra and is never printed.
 * sessions/.github.json holds only login / scopes / verifiedAt for the cockpit.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { isMainModule } from "./is-main.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const STATE = join(ROOT, "sessions", ".github.json");
export const ABRA_PROJECT = "gotchibot";
export const ABRA_KEY = "GOTCHIBOT_GITHUB_PAT";
export const TOKEN_URL =
  "https://github.com/settings/tokens/new?description=GotchiBot&scopes=repo,read:org,workflow";

function has(cmd) {
  return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}

export function loadGithubState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
}

function saveGithubState(patch) {
  mkdirSync(dirname(STATE), { recursive: true });
  const next = { ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function clearGithubState() {
  if (existsSync(STATE)) unlinkSync(STATE);
}

/** true / false, or null when abra is unavailable. Reads key names only. */
export function abraHasToken() {
  if (!has("abra")) return null;
  const r = spawnSync("abra", ["ls", ABRA_PROJECT], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status !== 0) return null;
  return stripVTControlCharacters(String(r.stdout || ""))
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[0] === ABRA_KEY);
}

/** gh CLI login name, or null when gh is missing / logged out. */
export function ghLogin() {
  if (!has("gh")) return null;
  const r = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const text = `${r.stdout || ""}${r.stderr || ""}`;
  return text.match(/Logged in to github\.com (?:as|account) (\S+)/)?.[1] || null;
}

/** One-line summary for the Settings header — cached, no vault or network calls. */
export function githubSummary() {
  const s = loadGithubState();
  if (!s?.login) return "not connected";
  return `@${s.login}${s.via === "gh" ? " (gh login)" : ""}`;
}

function githubApi(path, token) {
  return fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "gotchibot",
    },
  });
}

/** Most recently pushed first; one request, the cockpit pages through it locally. */
const RECENT_REPOS_PATH =
  "user/repos?sort=pushed&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member";

function repoSummary(r) {
  return {
    fullName: r.full_name,
    name: r.name,
    private: r.private === true,
    pushedAt: r.pushed_at,
    description: r.description || "",
    defaultBranch: r.default_branch || null,
    local: existsSync(join(dirname(ROOT), r.name)),
  };
}

/** Runs inside `abra run -k GOTCHIBOT_GITHUB_PAT`; prints { ok, repos } only. */
async function reposWithToken() {
  const token = process.env[ABRA_KEY];
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: `${ABRA_KEY} not in abra project ${ABRA_PROJECT}` }));
    return;
  }
  try {
    const res = await githubApi(RECENT_REPOS_PATH, token);
    if (!res.ok) {
      console.log(JSON.stringify({ ok: false, error: `GitHub rejected the token (HTTP ${res.status})` }));
      return;
    }
    console.log(JSON.stringify({ ok: true, repos: (await res.json()).map(repoSummary) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `GitHub unreachable: ${e?.message || e}` }));
  }
}

/** Up to 100 repos, latest push first. gh login first (no Touch ID), then the abra token. */
export function listRecentRepos() {
  if (ghLogin()) {
    const r = spawnSync("gh", ["api", RECENT_REPOS_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status === 0) {
      try {
        return { ok: true, via: "gh", repos: JSON.parse(r.stdout).map(repoSummary) };
      } catch {
        /* fall through to abra */
      }
    }
  }
  if (!has("abra") || abraHasToken() === false) {
    return { ok: false, error: "GitHub not connected — cockpit → Settings → GitHub" };
  }
  const r = spawnSync(
    "abra",
    ["run", ABRA_PROJECT, "-k", ABRA_KEY, "--", process.execPath, SELF, "repos-with-token"],
    { cwd: ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 },
  );
  try {
    return { via: "token", ...JSON.parse(String(r.stdout || "").trim().split("\n").pop()) };
  } catch {
    return { ok: false, error: `abra run failed (exit ${r.status ?? "?"})` };
  }
}

/** Runs inside `abra run -k GOTCHIBOT_GITHUB_PAT`; prints { ok, login, scopes } only. */
async function whoami() {
  const token = process.env[ABRA_KEY];
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: `${ABRA_KEY} not in abra project ${ABRA_PROJECT}` }));
    return;
  }
  try {
    const res = await githubApi("user", token);
    if (!res.ok) {
      console.log(JSON.stringify({ ok: false, error: `GitHub rejected the token (HTTP ${res.status})` }));
      return;
    }
    const j = await res.json();
    const scopes = String(res.headers.get("x-oauth-scopes") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    console.log(JSON.stringify({ ok: true, login: j.login, scopes }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `GitHub unreachable: ${e?.message || e}` }));
  }
}

/** Check the stored token against GitHub and cache who it belongs to. */
export function verifyGithub({ via } = {}) {
  if (!has("abra")) return { ok: false, error: "abra not installed" };
  const r = spawnSync(
    "abra",
    ["run", ABRA_PROJECT, "-k", ABRA_KEY, "--", process.execPath, SELF, "whoami"],
    { cwd: ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  const line = String(r.stdout || "").trim().split("\n").pop() || "";
  let out;
  try {
    out = JSON.parse(line);
  } catch {
    return { ok: false, error: `abra run failed (exit ${r.status ?? "?"})` };
  }
  if (out.ok) {
    const prev = loadGithubState() || {};
    saveGithubState({
      login: out.login,
      scopes: out.scopes,
      via: via || prev.via || "token",
      verifiedAt: new Date().toISOString(),
    });
  }
  return out;
}

function storeToken(input) {
  const args = ["set", ABRA_PROJECT, ABRA_KEY];
  if (input != null) args.push("--stdin");
  const r = spawnSync("abra", args, {
    cwd: ROOT,
    input: input ?? undefined,
    stdio: [input != null ? "pipe" : "inherit", "inherit", "inherit"],
  });
  return r.status === 0;
}

/** Copy the gh CLI's token into abra (never printed), then verify. */
export function connectWithGh() {
  if (!has("abra")) return { ok: false, error: "abra not installed" };
  if (!ghLogin()) return { ok: false, error: "gh is not logged in — run: gh auth login" };
  const t = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const token = String(t.stdout || "").trim();
  if (t.status !== 0 || !token) return { ok: false, error: "gh auth token returned nothing" };
  if (!storeToken(token)) return { ok: false, error: "abra set failed" };
  return verifyGithub({ via: "gh" });
}

/** Hidden abra prompt for a PAT the human created at TOKEN_URL, then verify. */
export function connectWithToken() {
  if (!has("abra")) return { ok: false, error: "abra not installed" };
  if (!storeToken(null)) return { ok: false, error: "abra set cancelled or failed" };
  return verifyGithub({ via: "token" });
}

export function disconnectGithub() {
  let removed = false;
  if (has("abra") && abraHasToken()) {
    removed = spawnSync("abra", ["rm", ABRA_PROJECT, ABRA_KEY], { cwd: ROOT, stdio: "inherit" }).status === 0;
    if (!removed) return { ok: false, error: "abra rm failed" };
  }
  clearGithubState();
  return { ok: true, removed };
}

function report(r, okText) {
  if (r.ok) console.log(okText(r));
  else {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const connected = (r) => `✓ GitHub connected as @${r.login}${r.scopes?.length ? ` · scopes ${r.scopes.join(", ")}` : ""}`;

  if (cmd === "whoami") return whoami();
  if (cmd === "repos-with-token") return reposWithToken();
  if (cmd === "repos") {
    const r = listRecentRepos();
    if (!r.ok) return report(r);
    if (json) return console.log(JSON.stringify(r.repos, null, 2));
    for (const repo of r.repos) console.log(`${repo.pushedAt}  ${repo.fullName}${repo.private ? "  (private)" : ""}`);
    return;
  }
  if (cmd === "status") {
    const state = loadGithubState();
    const live = rest.includes("--live");
    const out = {
      login: state?.login || null,
      via: state?.via || null,
      scopes: state?.scopes || [],
      verifiedAt: state?.verifiedAt || null,
      tokenInAbra: live ? abraHasToken() : undefined,
      ghLogin: live ? ghLogin() : undefined,
    };
    if (json) return console.log(JSON.stringify(out, null, 2));
    console.log(`github   ${githubSummary()}`);
    if (out.verifiedAt) console.log(`verified ${out.verifiedAt}`);
    if (live) {
      console.log(`abra     ${ABRA_PROJECT}/${ABRA_KEY} ${out.tokenInAbra ? "present" : out.tokenInAbra === false ? "missing" : "(abra unavailable)"}`);
      console.log(`gh       ${out.ghLogin ? `@${out.ghLogin}` : "(not logged in)"}`);
    }
    return;
  }
  if (cmd === "connect-gh") return report(connectWithGh(), connected);
  if (cmd === "connect-token") {
    console.log(`Create a token (repo, read:org, workflow): ${TOKEN_URL}`);
    return report(connectWithToken(), connected);
  }
  if (cmd === "verify") return report(verifyGithub(), connected);
  if (cmd === "disconnect") {
    return report(disconnectGithub(), (r) => (r.removed ? `✓ removed ${ABRA_KEY} from abra` : "✓ nothing stored — cleared"));
  }
  console.error(
    "usage: github-connect status [--json] [--live] | repos [--json] | connect-gh | connect-token | verify | disconnect",
  );
  process.exit(2);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
