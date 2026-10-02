#!/usr/bin/env node
/**
 * Interactive welcome / sign-in gate for GotchiBot tmux (center pane).
 */
import readline from "node:readline/promises";
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { stripVTControlCharacters } from "node:util";
import {
  ROOT,
  loadBaseStarterCollaterals,
  readWelcomeArt,
  readWalletFile,
  saveWalletFile,
  loadOnboarding,
  saveOnboarding,
  commandExists,
  runAbraNode,
  fetchCartridgeHeroes,
  fetchWalletGotchis,
  fetchWalletGotchiById,
  bindOwnedGotchi,
  pinAvatar,
} from "./onboarding-lib.mjs";
import { loadMeta, saveMeta } from "./identity.mjs";
import {
  readGotchiBotCartridgeSepolia,
  readAbraCartridgeSepolia,
  formatAbraCartLine,
} from "./cartridge-sepolia.mjs";
import { runLayout, tmuxSessionName as layoutSession } from "./tmux-layout.mjs";
import { withStatusBar, Progress } from "./progress-bar.mjs";
import { bootMark } from "./boot-trace.mjs";

const CONCIERGE_MINT_URL = "https://www.aarcadeghst.com/concierge/terminal";
const MARKETPLACE_URL = "https://aarcadeghst.com/gotchibot-templates";

function tmuxSessionName() {
  return layoutSession();
}

function meetGalleryLayout(cmd) {
  // enter/refresh/leave all may respawn work.1 — must run detached on work.0.
  // Running enter-meet-gallery with inheritStdio on work.1 was the Files-only crash:
  // layout respawned the center pane and aborted mid-flight.
  const killsCenter =
    cmd === "leave-meet-gallery" ||
    cmd === "enter-meet-gallery" ||
    cmd === "refresh-meet-gallery";
  runLayout(cmd, {
    background: killsCenter,
    target: killsCenter ? "work.0" : undefined,
    inheritStdio: false,
  });
}

function enterMeetGalleryLayout() {
  meetGalleryLayout("enter-meet-gallery");
}

/** Switch tmux to meet room — must use tmux run-shell (not chat-pane child). */
function openMeetRoomFromPane() {
  try {
    rl.close();
  } catch {}
  if (!tmuxSessionName()) {
    console.log("\n  ✗ attach tmux first: ./scripts/gotchibot tmux\n");
    process.exit(1);
  }
  enterMeetGalleryLayout();
  // 4 = chat-pane show_cockpit / show_meet → enter_meet_room (do not boot OpenCode).
  process.exit(4);
}

function refreshMeetGalleryLayout() {
  meetGalleryLayout("refresh-meet-gallery");
}

function leaveMeetGalleryLayout() {
  meetGalleryLayout("leave-meet-gallery");
}

/** Switch tmux to pstack dossier layout — pstack-window replaces chat (work.1), avatar stays on right (work.2). */
function enterPstackDossierLayout() {
  if (!tmuxSessionName()) {
    console.log("\n  ✗ attach tmux first: ./scripts/gotchibot tmux\n");
    return;
  }
  runLayout("enter-pstack-dossier");
  console.log("\n  ✓ pstack dossier pane open (work.1).");
  console.log("    Leave with: ./scripts/orchestrator-layout.sh leave-pstack-dossier");
}

/** Factory pane in the dossier slot: project bots + workflows, Hub, desk infra. */
function enterFactoryLayout() {
  if (!tmuxSessionName()) {
    console.log("\n  ✗ attach tmux first: ./scripts/gotchibot tmux\n");
    return;
  }
  runLayout("enter-factory");
  console.log("\n  ✓ Factory pane open (work.1) · c returns to the cockpit.");
}

/** Current project slug — desk resolves local dossiers + Sepolia checkpoint (ignores smoke leftovers). */
function currentProjectSlug() {
  const r = spawnSync(
    process.execPath,
    [`${ROOT}/scripts/project-context.mjs`, "current", "--resolve"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  const slug = String(r.stdout || "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .pop();
  return slug || null;
}

function listProjectSlugs() {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/pstack-dossier.mjs`, "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return [];
  try {
    const j = JSON.parse(String(r.stdout || "{}"));
    if (Array.isArray(j)) return j.map((x) => (typeof x === "string" ? x : x.slug)).filter(Boolean);
    if (Array.isArray(j.dossiers)) {
      return j.dossiers.map((x) => (typeof x === "string" ? x : x.slug)).filter(Boolean);
    }
    if (Array.isArray(j.programs)) return j.programs.map((x) => x.slug || x).filter(Boolean);
    if (Array.isArray(j.slugs)) return j.slugs.filter(Boolean);
  } catch {}
  // Fallback: parse human list lines
  const human = spawnSync(process.execPath, [`${ROOT}/scripts/pstack-dossier.mjs`, "list"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return String(human.stdout || "")
    .split("\n")
    .map((line) => {
      const m = line.match(/^\*?[✓!]?\s*([a-z0-9][a-z0-9._-]{0,63})\s*·/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

function setCurrentProject(slug) {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/project-context.mjs`, "set", slug], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    console.log(`  ✗ could not set project: ${String(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
    return false;
  }
  return true;
}

/** @returns {Promise<boolean>} true when the binding changed */
async function connectRepoPrompt(slug, { optional = false } = {}) {
  const { loadRepo, connectRepo, disconnectRepo, formatRepo } = await import("./project-context.mjs");
  const cur = loadRepo(slug);
  if (cur) console.log(`  repo     ${formatRepo(cur)}`);
  console.log("  Repo: a folder (~/Dev/foo, or just foo), a git URL, or GitHub owner/repo.");
  const hint = cur ? "Enter keeps it, - disconnects" : optional ? "Enter skips" : "Enter cancels";
  const raw = (await rl.question(`  Repo (${hint}): `)).trim();
  if (!raw) return false;
  if (raw === "-") {
    if (!cur) return false;
    disconnectRepo(slug);
    console.log(`  ✓ repo disconnected from ${slug}`);
    return true;
  }
  try {
    const r = connectRepo(raw, slug, { cwd: ROOT });
    console.log(`  ✓ repo → ${formatRepo(r)}`);
    if (!r.path) console.log(`  · no matching checkout under ~/Dev — clone it there and reconnect to link the folder`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${e?.message || e}`);
    return false;
  }
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  const units = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
  for (const [u, n] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return "just now";
}

const REPO_PAGE_SIZE = 10;

/** Latest-pushed GitHub repos, 10 per page; pick one to connect to the project. */
async function pickGithubRepo(slug, { optional = false } = {}) {
  const gh = await import("./github-connect.mjs");
  const { loadRepo, connectRepo, disconnectRepo, formatRepo } = await import("./project-context.mjs");
  console.log("\n  Loading your GitHub repos (latest changes first)…");
  const res = withTty(() => gh.listRecentRepos());
  if (!res.ok || !res.repos?.length) {
    console.log(`  · ${res.ok ? "no repos on this GitHub account" : res.error}`);
    await connectRepoPrompt(slug, { optional });
    await pause();
    return;
  }
  const repos = res.repos;
  const totalPages = Math.ceil(repos.length / REPO_PAGE_SIZE);
  let page = 0;
  for (;;) {
    const cur = loadRepo(slug);
    const slice = repos.slice(page * REPO_PAGE_SIZE, (page + 1) * REPO_PAGE_SIZE);
    const width = Math.max(...slice.map((r) => r.fullName.length));
    clear();
    title("Connect to GitHub repo");
    console.log(`  project  ${slug}`);
    console.log(`  repo     ${formatRepo(cur)}\n`);
    console.log(`  ${repos.length} repos · latest changes first · page ${page + 1}/${totalPages}`);
    const options = slice.map((r) => ({
      key: "repo",
      repo: r,
      label: [
        r.fullName.padEnd(width),
        timeAgo(r.pushedAt).padStart(8),
        r.private ? "private" : "",
        r.local ? "· local" : "",
      ]
        .filter(Boolean)
        .join("  "),
    }));
    if (page < totalPages - 1) options.push({ key: "next", hotkey: "n", label: "Next page" });
    if (page > 0) options.push({ key: "prev", hotkey: "p", label: "Previous page" });
    options.push({ key: "manual", hotkey: "m", label: "Type a folder, git URL, or owner/repo" });
    if (cur) options.push({ key: "disconnect", hotkey: "d", label: "Disconnect repo" });
    options.push({ key: "back", hotkey: "b", label: optional ? "Skip" : "Back" });

    const pick = await choose("Which repo?", options);
    if (!pick || pick.key === "back") return;
    if (pick.key === "next") page++;
    else if (pick.key === "prev") page--;
    else if (pick.key === "manual") {
      const changed = await connectRepoPrompt(slug);
      await pause();
      if (changed) return;
    } else if (pick.key === "disconnect") {
      disconnectRepo(slug);
      console.log(`  ✓ repo disconnected from ${slug}`);
      await pause();
    } else {
      try {
        const r = connectRepo(pick.repo.fullName, slug, { cwd: ROOT });
        console.log(`\n  ✓ repo → ${formatRepo(r)}`);
        if (!r.path) console.log("  · no matching checkout under ~/Dev — clone it there and reconnect to link the folder");
        await pause();
        return;
      } catch (e) {
        console.log(`  ✗ ${e?.message || e}`);
        await pause();
      }
    }
  }
}

async function selectProjectMenu({ freshInstall = false } = {}) {
  title("Select project");
  console.log("  Projects are sealed rooms — bots, meetings, and notes stay inside.");
  console.log("  Cart mirror: signed checkpoint (local default; IPFS via Settings).\n");
  const current = currentProjectSlug();
  if (current) {
    const { loadRepo, formatRepo } = await import("./project-context.mjs");
    console.log(`  current  ${current}`);
    console.log(`  repo     ${formatRepo(loadRepo(current))}\n`);
  }

  // Always list dossiers so a just-created project can be re-picked if the
  // pointer was cleared. Fresh nest only changes the nudge copy — not the list.
  const slugs = listProjectSlugs();
  if (freshInstall) {
    console.log("  Fresh roster — create a new project or pick an existing one.\n");
  }
  const options = [
    ...slugs.map((slug) => ({
      key: `proj:${slug}`,
      label: slug === current ? `${slug}  (current)` : slug,
    })),
    ...(current ? [{ key: "repo", label: "Connect to GitHub repo…" }] : []),
    { key: "new", label: "Create new project…" },
    { key: "back", label: "Back to cockpit" },
  ];
  const pick = await choose("Which project?", options);
  if (!pick || pick.key === "back") return;

  if (pick.key === "repo") {
    await pickGithubRepo(current);
    return;
  }

  if (pick.key === "new") {
    const raw = (await rl.question("  New project slug (a-z0-9._-): ")).trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw)) {
      console.log("  ✗ invalid slug");
      await pause();
      return;
    }
    const titleText = (await rl.question("  Title (optional): ")).trim();
    const goal = (await rl.question("  Goal (optional): ")).trim();
    const args = [`${ROOT}/scripts/pstack-dossier.mjs`, "new", raw];
    if (titleText) args.push("--title", titleText);
    if (goal) args.push("--goal", goal);
    const created = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    if (created.status !== 0) {
      console.log(`  ✗ ${String(created.stderr || created.stdout || "").trim() || `exit ${created.status}`}`);
      await pause();
      return;
    }
    console.log(String(created.stdout || "").trim() || `  ✓ created ${raw}`);
    if (!setCurrentProject(raw) || currentProjectSlug() !== raw) {
      console.log(`  ✗ project pointer did not stick for ${raw} — pick it from the list`);
      await pause();
      return;
    }
    console.log(`  ✓ project → ${raw}`);
    await pause("Press Enter to connect a GitHub repo (you can skip)…");
    await pickGithubRepo(raw, { optional: true });
    return;
  }

  if (pick.key.startsWith("proj:")) {
    const slug = pick.key.slice("proj:".length);
    if (setCurrentProject(slug) && currentProjectSlug() === slug) {
      console.log(`\n  ✓ project → ${slug}`);
    } else {
      console.log(`\n  ✗ could not select ${slug}`);
    }
    await pause();
  }
}

const rl = readline.createInterface({ input, output });

// Keep one blank row under every prompt so it never sits flush on the tmux status bar.
const rawQuestion = rl.question.bind(rl);
rl.question = (query, ...rest) => {
  const answer = rawQuestion(query, ...rest);
  if (output.isTTY) {
    const last = stripVTControlCharacters(String(query)).split("\n").pop();
    output.write(`\n\x1b[1A\x1b[${[...last].length + 1}G`);
  }
  return answer;
};

function clear() {
  output.write("\x1b[2J\x1b[H\x1b[3J");
}

function hr() {
  console.log("────────────────────────────────────────────────────────");
}

function title(text) {
  console.log(`\n  ${text}\n`);
}

async function pause(msg = "Press Enter to continue…") {
  await rl.question(`\n  ${msg}`);
}


const OPENCLAW_SAYINGS = [
  "Claws out. Agents in.",
  "One haunt, many hands.",
  "I pinch the tasks. You keep the Spirit Force.",
  "The claw spins the fleet. The gotchi talks.",
  "Don't go silent — reply first, then haunt the work.",
  "Sub-agents spawn. Kinship stays here.",
];

function quirkyOpenclawSaying() {
  return OPENCLAW_SAYINGS[Math.floor(Math.random() * OPENCLAW_SAYINGS.length)];
}

const QUIT_CODE = 2;

function quitToTerminal() {
  try {
    rl.close();
  } catch {}
  process.exit(QUIT_CODE);
}

/** Options with `hotkey` are listed under the numbered ones and picked by that letter. */
async function choose(prompt, options) {
  console.log("");
  const numbered = options.filter((o) => !o.hotkey);
  const hot = options.filter((o) => o.hotkey);
  numbered.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  hot.forEach((o) => console.log(`    ${o.hotkey}) ${o.label}`));
  console.log(`    q) Quit`);
  const range = [`1-${numbered.length}`, ...hot.map((o) => o.hotkey)].join("/");
  for (;;) {
    const ans = (await rl.question(`\n  ${prompt} [${range}]: `)).trim().toLowerCase();
    if (ans === "q" || ans === "quit") quitToTerminal();
    const hit = hot.find((o) => o.hotkey === ans);
    if (hit) return hit;
    const n = Number(ans);
    if (n >= 1 && n <= numbered.length) return numbered[n - 1];
    console.log("  invalid choice");
  }
}

/** Cartridge writes on Base Sepolia: MetaMask pages for binds/mints, desk pin for orch. */
async function apiOp(op, ...args) {
  if (op === "select-hero") return args[0];
  if (op === "bind-owned") return bindOwnedGotchi(null, args[0], args[1] || null);
  if (op === "bind-starter" || op === "mint-sub") {
    const option =
      typeof args[0] === "object" ? args[0] : loadBaseStarterCollaterals().find((c) => c.id === args[0]);
    if (!option) throw new Error(`unknown starter collateral "${args[0]}"`);
    const { bindStarterToDesk } = await import("./cartridge-mint-sepolia.mjs");
    return bindStarterToDesk(option);
  }
  throw new Error(`unknown cartridge op ${op}`);
}

function openConcierge(extraNote = "") {
  console.log(`\n  Opening Concierge for on-chain bind (MetaMask will prompt)…`);
  if (extraNote) console.log(`  ${extraNote}`);
  console.log(`  ${CONCIERGE_MINT_URL}\n`);
  try {
    spawn("open", [CONCIERGE_MINT_URL], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open manually */
  }
}

function openMarketplace(extraNote = "") {
  console.log(`\n  Opening Marketplace…`);
  if (extraNote) console.log(`  ${extraNote}`);
  console.log(`  Pulling packs from ${MARKETPLACE_URL}\n`);
  const r = spawnSync(
    process.execPath,
    [`${ROOT}/scripts/marketplace-menu.mjs`],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (r.status !== 0 && r.status != null) {
    console.log(`  · menu exited ${r.status} — falling back to catalog list`);
    const listed = spawnSync(
      process.execPath,
      [`${ROOT}/scripts/template-pack.mjs`, "list", "--remote"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (listed.stdout) process.stdout.write(listed.stdout);
    if (listed.stderr) process.stderr.write(listed.stderr);
  }
}

async function setOrchestratorHero(heroId, wallet, cartridgeId) {
  pinAvatar(heroId);
  saveOnboarding({
    complete: true,
    orchestratorHeroId: heroId,
    wallet,
    cartridgeId,
  });
  saveMeta({ activeHeroId: heroId });
  // Assignment label: nest orchestrator pack + equip slot 15 on this cGotchi.
  try {
    const { equipPack } = await import("./pack-wearable.mjs");
    const eq = equipPack(heroId, "orchestrator");
    console.log(`  ✓ pack wearable → slot ${eq.slot}  (${eq.packId})  [orch assignment]`);
  } catch (e) {
    console.log(`  · pack wearable equip skipped: ${e?.message || e}`);
  }
  try {
    await syncFleetQuiet();
  } catch {
    /* fleet optional while Hub is down */
  }
}

/** First cGotchi on the desk becomes orch + slot-15 orchestrator pack. Later mints stay subs. */
async function assignAsOrchestratorIfFirst(heroId, wallet, cartridgeId, opts = {}) {
  if (!heroId) return false;
  if (loadOnboarding()?.orchestratorHeroId) return false;
  await setOrchestratorHero(heroId, wallet, cartridgeId, opts);
  console.log(`  ✓ first gotchi → orchestrator (${heroId})`);
  return true;
}

/** First cAavegotchi on a fresh desk — mint/bind first, then ask to set orch. */
async function runFirstOrchMintMenu(wallet, cartridgeId) {
  for (;;) {
    title("Add cAavegotchi");
    console.log("  First step: get a cAavegotchi on the desk (and on-chain roster when you mint).");
    console.log("  After that, you can set it as orchestrator (desk orch pack · slot 15).\n");
    const pickOpts = [
      { key: "wallet", label: "Mint wallet cAavegotchi (free)" },
      { key: "collateral", label: "Mint base collateral ($5 USDC)" },
      { key: "marketplace", label: "View Marketplace" },
      { key: "view", label: "View cart roster / set orch from roster" },
      { key: "concierge", label: "Open Concierge only (bind / mint on-chain)" },
      { key: "back", label: "Back / quit" },
    ];

    const pick = await choose("How to add your first cAavegotchi?", pickOpts);
    if (!pick || pick.key === "back") return null;

    if (pick.key === "marketplace") {
      title("Marketplace");
      console.log("  Bot-template packs for cAavegotchi assignment (slot 15).\n");
      openMarketplace();
      continue;
    }

    if (pick.key === "view") {
      const setId = await viewCartCAavegotchisMenu(wallet, cartridgeId);
      if (setId) return setId;
      continue;
    }

    if (pick.key === "concierge") {
      openConcierge("Bind owned/starter — MetaMask will prompt.");
      await pause("Press Enter after you finish in Concierge…");
      const nest = await fetchDeskHeroes(wallet, cartridgeId);
      if (!nest.length) {
        console.log("  · No roster heroes yet — bind one in browser, then return.");
        await pause();
        continue;
      }
      const heroId = String(nest[0].id);
      const asOrch = await askSetAsOrch(heroId, wallet, cartridgeId);
      if (asOrch) return asOrch;
      continue;
    }

    if (pick.key === "wallet") {
      const heroId = await runWalletGotchiMint(wallet, cartridgeId);
      if (!heroId) continue;
      const asOrch = await askSetAsOrch(heroId, wallet, cartridgeId);
      if (asOrch) return asOrch;
      continue;
    }

    // collateral
    const heroId = await runCollateralGotchiMint(wallet, cartridgeId);
    if (!heroId) continue;
    const asOrch = await askSetAsOrch(heroId, wallet, cartridgeId);
    if (asOrch) return asOrch;
  }
}

/** After a cGotchi exists — opt-in orch (slot 15). Returns heroId if set, else null. */
async function askSetAsOrch(heroId, wallet, cartridgeId) {
  if (!heroId) return null;
  console.log(`\n  ✓ cAavegotchi ready · ${heroId}`);
  console.log("  Orch assignment is desk-local (orch pack · slot 15 in sessions) — no MetaMask.");
  const ans = (await rl.question("  Set as orchestrator (orch pack · slot 15)? [Y/n]: ")).trim().toLowerCase();
  if (ans === "n" || ans === "no") {
    console.log("  · Left unset — pick again or set from roster when ready.");
    await pause();
    return null;
  }
  await setOrchestratorHero(heroId, wallet, cartridgeId);
  console.log(`  ✓ orchestrator → ${heroId}`);
  await pause();
  return heroId;
}

function shortHeroId(id) {
  const s = String(id || "");
  if (s.startsWith("0x") && s.length > 18) return `${s.slice(0, 10)}…${s.slice(-6)}`;
  return s;
}

/** @returns {Promise<string|null>} orch hero id if user set one */
async function viewCartCAavegotchisMenu(wallet, cartridgeId) {
  title("cAavegotchis on cart");
  if (!cartridgeId) {
    console.log("  No GotchiBot cart yet — mint one first.");
    await pause();
    return null;
  }
  const nest = await fetchDeskHeroes(wallet, cartridgeId);
  const orch = await resolveValidOrchestratorId(wallet, cartridgeId, nest);
  const meta = loadMeta() || {};
  console.log(`  cart       #${cartridgeId}`);
  console.log(`  desk orch  ${orch || "(none)"}`);
  if (meta.activeHeroId && String(meta.activeHeroId) !== String(orch || "")) {
    console.log(`  active     ${meta.activeHeroId}`);
  }
  console.log("");
  if (!nest.length) {
    console.log("  (none bound on-chain yet — pick wallet gotchi or mint collateral)");
    await pause();
    return null;
  }
  nest.forEach((h, i) => {
    const id = String(h.id);
    const mark = orch && String(orch) === id ? "  ← orch" : "";
    console.log(`  ${String(i + 1).padStart(2)}) ${shortHeroId(id)}${mark}`);
  });
  const opts = [
    { key: "set", label: "Set desk orch from a cart hero" },
    { key: "back", label: "Back" },
  ];
  const pick = await choose("Cart heroes", opts);
  if (!pick || pick.key === "back") return null;
  const options = nest.map((h) => ({
    key: String(h.id),
    label: shortHeroId(h.id),
  }));
  const gPick = await choose("Which cart hero becomes orch?", options);
  if (!gPick) return null;
  await setOrchestratorHero(gPick.key, wallet, cartridgeId);
  console.log(`  ✓ orchestrator → ${gPick.key}`);
  await pause();
  return gPick.key;
}

/** Sepolia: only gotchis whose Mock L1 ownerOf matches the wallet (bindOwned will work). */
async function filterSepoliaMockOwnedGotchis(wallet, gotchis) {
  const { readFileSync } = await import("node:fs");
  const { join, dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let l1Addr = String(process.env.L1_AAVEGOTCHI_DIAMOND || "").trim();
  if (!l1Addr) {
    try {
      const cfg = JSON.parse(readFileSync(join(root, "config/cartridgeChain.base-sepolia.json"), "utf8"));
      l1Addr = String(cfg.l1AavegotchiDiamond || "").trim();
    } catch {
      return gotchis;
    }
  }
  if (!l1Addr || l1Addr === "0x0000000000000000000000000000000000000000") return gotchis;

  let ethersMod;
  try {
    ethersMod = await import("ethers");
  } catch {
    ethersMod = await import(resolve(root, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js"));
  }
  const ethers = ethersMod.ethers || ethersMod.default || ethersMod;
  const rpc = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const l1 = new ethers.Contract(l1Addr, ["function ownerOf(uint256) view returns (address)"], provider);
  const want = String(wallet).toLowerCase();
  const zero = "0x0000000000000000000000000000000000000000";
  const out = [];
  for (const g of gotchis) {
    const id = String(g.gotchiId ?? g.id ?? "");
    if (!/^\d+$/.test(id)) continue;
    try {
      const owner = String(await l1.ownerOf(BigInt(id))).toLowerCase();
      if (owner && owner !== zero && owner === want) out.push(g);
    } catch {
      /* not on mock */
    }
  }
  return out;
}

/** Mint/bind wallet gotchi — does not set orch (caller asks). */
async function runWalletGotchiMint(wallet, cartridgeId) {
  let onChain = [];
  try {
    onChain = await withStatusBar("Loading gotchis from subgraph…", (onStatus) =>
      fetchWalletGotchis(wallet, { onStatus }),
    );
  } catch (e) {
    console.log(`  Subgraph: ${e.message || e}`);
  }
  if (onChain.length) {
    try {
      const seeded = await withStatusBar("Checking Sepolia Mock L1…", () =>
        filterSepoliaMockOwnedGotchis(wallet, onChain),
      );
      if (!seeded.length) {
        console.log("\n  No wallet gotchis seeded on Sepolia Mock L1 yet.");
        console.log("  Only Mock-owned ids can mint free (e.g. #22899). Seed more or mint base collateral.");
        await pause();
        return null;
      }
      if (seeded.length < onChain.length) {
        console.log(
          `  · Sepolia: showing ${seeded.length} Mock-seeded of ${onChain.length} Base wallet gotchis`,
        );
      }
      onChain = seeded;
    } catch (e) {
      console.log(`  · Mock L1 filter skipped: ${e?.message || e}`);
    }
  }
  if (!onChain.length) {
    console.log("\n  No Aavegotchis in this wallet.");
    console.log("  Buy/mint one on Base, or mint base collateral ($5 USDC).");
    await pause();
    return null;
  }
  const options = onChain.slice(0, 40).map((g) => ({
    key: String(g.gotchiId ?? g.id),
    label: formatGotchiLabel(g),
    gotchi: g,
  }));
  const cartHeroes = cartridgeId
    ? await withStatusBar("Loading cartridge cAavegotchis…", () => fetchDeskHeroes(wallet, cartridgeId))
    : [];
  const bound = alreadyBoundTokenIds(cartHeroes);
  const pending = onChain.filter((g) => !bound.has(String(g.gotchiId ?? g.id))).length;
  if (cartridgeId && pending > 0) {
    const skipped = onChain.length - pending;
    options.push({
      key: "all",
      hotkey: "a",
      label: `Mint all ${pending} not on cart yet${skipped ? ` (${skipped} already on cart)` : ""} — one MetaMask confirm each`,
    });
  }
  const gPick = await choose("Which wallet gotchi?", options);
  if (!gPick) return null;
  if (gPick.key === "all") {
    const result = await mintAllWalletGotchis(wallet, cartridgeId, onChain, cartHeroes);
    return result?.bound?.[0]?.heroId || null;
  }
  const tokenId = String(gPick.key);
  const heroId = `owned-${tokenId}`;

  try {
    const { persistHeroCollateral, findCollateralColors } = await import("./collateral-resolve.mjs");
    const { libraryNameToSpiritId, fetchWalletGotchiById, walletGotchiTraits } = await import(
      "./onboarding-lib.mjs"
    );
    let g = gPick.gotchi || {};
    try {
      const full = await fetchWalletGotchiById(wallet, tokenId);
      if (full) g = { ...g, ...full };
    } catch {
      /* keep pick */
    }
    const hauntId = g.hauntId != null ? Number(g.hauntId) : null;
    const colors = findCollateralColors(g.collateral || g.collateralName || "", hauntId || 2);
    const spirit =
      colors?.spirit || libraryNameToSpiritId(g.collateralName || g.collateral || "") || null;
    const traits = walletGotchiTraits(g);
    persistHeroCollateral(heroId, {
      collateral: spirit,
      collateralAddress: g.collateral || null,
      collateralName: colors?.name || g.collateralName || null,
      hauntId,
      primary: colors?.primary,
      secondary: colors?.secondary,
      sourceTokenId: tokenId,
      modifiedTraits: traits || undefined,
      numericTraits: g.numericTraits || traits || undefined,
    });
    if (traits) {
      const eyeShape = Number(traits[4]);
      const eyeColor = Number(traits[5]);
      console.log(
        `  · cheeks  eyeShape ${String(eyeShape).padStart(2, "0")} · eyeColor ${String(eyeColor).padStart(2, "0")}`,
      );
    }
  } catch {
    /* optional */
  }

  if (!cartridgeId) {
    console.log("  · No cart id — mint/open a GotchiBot cart first.");
    await pause();
    return null;
  }
  const bar = new Progress();
  bar.set(5, `Minting wallet cAavegotchi #${tokenId}…`);
  try {
    const { runBindOwned, refreshDeskMeta } = await import("./cartridge-mint-sepolia.mjs");
    bar.set(15, `MetaMask bindOwned #${tokenId} — confirm in browser…`);
    let bound;
    try {
      bound = await bar.pulse(
        `Minting #${tokenId} (waiting on MetaMask)…`,
        () =>
          runBindOwned({
            expectWallet: wallet,
            cartridgeId: String(cartridgeId),
            sourceTokenId: tokenId,
          }),
        { nextPct: 85 },
      );
    } catch (bindErr) {
      bar.fail(`Mint #${tokenId} — failed`);
      throw bindErr;
    }
    if (bound?.ok) {
      try {
        await bar.pulse("Refreshing desk…", () => refreshDeskMeta(wallet), { nextPct: 95 });
      } catch {
        /* optional */
      }
      bar.done(`minted ${heroId}${bound.txHash ? ` · ${String(bound.txHash).slice(0, 10)}…` : ""}`);
      console.log(`  ✓ roster ${heroId}${bound.txHash ? ` · ${bound.txHash}` : ""}`);
      return heroId;
    }
    bar.fail(`Mint #${tokenId} — ${bound?.error || "skipped"}`);
    console.log(`  · Mint skipped/failed: ${bound?.error || "unknown"}`);
    console.log(`  · Desk cheeks kept for ${heroId} — retry when ready`);
    await pause();
    return null;
  } catch (e) {
    try {
      bar.fail(`Mint #${tokenId} — failed`);
    } catch {
      /* bar already closed */
    }
    console.log(`  · bindOwned page failed: ${e?.message || e}`);
    await pause();
    return null;
  }
}

async function pickCollateralOption(promptText) {
  const options = loadBaseStarterCollaterals();
  if (!options.length) throw new Error("no starter collaterals loaded — check assets/collateral-colors.json");

  console.log(`\n  ${promptText}\n`);
  options.forEach((c, i) => {
    console.log(`    ${String(i + 1).padStart(2)} ) ${c.libraryName.padEnd(10)} (H${c.hauntId})`);
  });
  for (;;) {
    const ans = (await rl.question(`\n  Collateral [1-${options.length}]: `)).trim();
    const n = Number(ans);
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log(`  pick 1–${options.length}`);
  }
}

/** Collateral starter mint — does not set orch (caller asks). */
async function runCollateralGotchiMint(wallet, cartridgeId) {
  if (!cartridgeId) {
    console.log("  · No cart id — mint/open a GotchiBot cart first.");
    await pause();
    return null;
  }
  let option;
  try {
    option = await pickCollateralOption("Choose collateral for cAavegotchi");
  } catch (e) {
    console.log(`  ✗ ${e?.message || e}`);
    await pause();
    return null;
  }

  console.log(`\n  Roster mint — MetaMask bindStarter · ${option.libraryName} · $5 USDC\n`);
  const bar = new Progress();
  bar.set(5, `Minting base collateral · ${option.libraryName}…`);
  try {
    const { bindStarterToDesk } = await import("./cartridge-mint-sepolia.mjs");
    bar.set(15, "MetaMask bindStarter — confirm in browser…");
    const heroId = await bar.pulse(
      `Minting ${option.libraryName} (waiting on MetaMask)…`,
      () => bindStarterToDesk(option),
      { nextPct: 95 },
    );
    bar.done(`minted ${heroId}`);
    console.log(`  ✓ roster starter ${option.id} → ${heroId}`);
    return heroId;
  } catch (e) {
    try {
      bar.fail(`Mint ${option.libraryName} — failed`);
    } catch {
      /* bar already closed */
    }
    console.log(`  · bindStarter failed: ${e?.message || e}`);
    await pause();
    return null;
  }
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

async function walletConnected(addr, source) {
  clear();
  console.log(readWelcomeArt(8));
  title("Wallet connected");
  console.log(`  ✓ ${shortAddr(addr)} verified via ${source}`);
  console.log("\n  Loading your gotchibot cartridge…\n");
  saveOnboarding({ wallet: addr });
  return addr;
}
async function waitForMetaMaskSave(sinceMs, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(`${ROOT}/sessions/.wallet.json`, "utf8");
      const w = JSON.parse(raw);
      const t = w.verifiedAt ? new Date(w.verifiedAt).getTime() : 0;
      if (w.address && t >= sinceMs) return w.address.toLowerCase();
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("wallet connect timed out — finish MetaMask sign-in in the browser");
}

async function runMetaMaskConnect() {
  const since = Date.now();
  console.log("\n  Opening Chrome/Brave for wallet sign-in…");
  console.log("  Install MetaMask in that browser if needed, then sign the message.\n");

  const child = spawn(process.execPath, [`${ROOT}/scripts/wallet-connect.mjs`], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  const addr = await waitForMetaMaskSave(since);
  try {
    spawnSync("bash", ["-c", "lsof -ti:8788 | xargs kill -9 2>/dev/null || true"], { stdio: "ignore" });
  } catch {}
  return addr;
}

async function connectWalletMenu() {
  clear();
  console.log(readWelcomeArt());
  title("Welcome to GotchiBot");
  console.log("  Connect a wallet to load your gotchibot cartridge.");
  console.log("  Sign-in proves ownership only — no transaction, no fee.\n");

  const saved = readWalletFile();
  const opts = [];
  if (saved) {
    opts.push({
      key: "saved",
      label: `Use saved wallet (${saved.slice(0, 6)}…${saved.slice(-4)})`,
      address: saved,
    });
  }
  opts.push({ key: "mm", label: "Browser wallet — MetaMask sign-in (Chrome/Brave)" });
  if (commandExists("abra")) {
    opts.push({ key: "abra", label: "Abracadabra — fetch wallet from vault (Touch ID)" });
  }

  const pick = await choose("Connect wallet", opts);
  if (!pick) quitToTerminal();

  if (pick.key === "saved") {
    return walletConnected(pick.address, "saved session");
  }

  if (pick.key === "mm") {
    const addr = await runMetaMaskConnect();
    return walletConnected(addr, "MetaMask");
  }

  if (pick.key === "abra") {
    console.log("\n  Approve Touch ID in abracadabra…");
    const r = spawnSync(
      "abra",
      ["run", "gotchibot", "-k", "GOTCHIBOT_OWNER", "--", "node", "-e", "process.stdout.write(process.env.GOTCHIBOT_OWNER||'')"],
      { encoding: "utf8", cwd: ROOT, stdio: ["inherit", "pipe", "pipe"] },
    );
    const addr = (r.stdout || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) {
      throw new Error("no GOTCHIBOT_OWNER in abracadabra — use MetaMask or abra set gotchibot GOTCHIBOT_OWNER");
    }
    saveWalletFile(addr, "abracadabra");
    return walletConnected(addr, "abracadabra");
  }

  throw new Error("unsupported wallet option");
}

async function ensureCartridge(wallet) {
  title("Cartridge");
  try {
    const sep = await readGotchiBotCartridgeSepolia(wallet);
    saveMeta({ owner: wallet, cartridgeSource: "sepolia", cartridgeId: sep.cartridgeId || null });

    if (!sep.cartridgeId || sep.heroCount === 0) {
      // Fresh Sepolia roster — drop any stale orch pin so cockpit shows unset.
      saveOnboarding({
        wallet,
        cartridgeId: sep.cartridgeId || null,
        orchestratorHeroId: null,
        complete: Boolean(sep.cartridgeId),
      });
      saveMeta({ activeHeroId: null });
      try {
        unlinkSync(`${ROOT}/sessions/.pin`);
      } catch {}
    } else {
      saveOnboarding({ wallet, cartridgeId: sep.cartridgeId });
    }

    if (sep.cartridgeId) {
      console.log(`  ✓ Base Sepolia cartridge ${sep.cartridgeId} · ${sep.heroCount} cAavegotchi(s)`);
      return sep.cartridgeId;
    }
    console.log("  · Base Sepolia: no cartridge yet");
    console.log(`  · Mint nested sealed cart: ${CONCIERGE_MINT_URL}`);
    return null;
  } catch (e) {
    console.log(`  · Sepolia read failed: ${e?.message || e}`);
    // A flaky RPC must not abort a desk that already has a cartridge on file.
    const cached = loadMeta()?.cartridgeId;
    if (cached) {
      console.log(`  ✓ cartridge ${cached} (cached — Sepolia unreachable)`);
      return cached;
    }
    console.log(`  · Mint at Concierge: ${CONCIERGE_MINT_URL}`);
    return null;
  }
}

async function fetchDeskHeroes(wallet, cartridgeId) {
  if (!cartridgeId) return [];
  try {
    return await fetchCartridgeHeroes(cartridgeId);
  } catch {
    return [];
  }
}

/** Orch from cartridge heroes or the desk-local pin. Pass `nest` when already fetched. */
async function resolveValidOrchestratorId(wallet, cartridgeId, nest = null) {
  const ob = loadOnboarding();
  const meta = loadMeta() || {};
  const raw = ob.orchestratorHeroId || null;
  if (!cartridgeId) return raw;
  if (!raw) return null;

  nest = nest ?? (await fetchDeskHeroes(wallet, cartridgeId));
  const nestIds = new Set((nest || []).map((h) => String(h.id)));
  if (nestIds.has(String(raw))) return raw;

  // Desk-local orch (assigned before Concierge nest bind) — keep pin.
  if (meta.activeHeroId && String(meta.activeHeroId) === String(raw)) return raw;
  if (String(raw).startsWith("owned-") || String(raw).startsWith("starter-")) return raw;

  console.log(`  · clearing stale orch pin ${raw} (not on this roster desk)`);
  saveOnboarding({ orchestratorHeroId: null });
  if (meta.activeHeroId && String(meta.activeHeroId) === String(raw)) {
    saveMeta({ activeHeroId: null });
  }
  return null;
}

const GOTCHI_PAGE_SIZE = 25;

function formatGotchiLabel(g) {
  const id = String(g.gotchiId ?? g.id ?? "");
  const label = g.name ? `"${g.name}"` : "(unnamed)";
  return `#${id}  ${label}`;
}

function formatCartridgeHeroLabel(h) {
  const parts = [h.id];
  if (h.bindType) parts.push(h.bindType);
  if (h.collateral) parts.push(String(h.collateral).slice(0, 12));
  if (h.name) parts.push(`"${h.name}"`);
  return parts.join(" · ");
}

function renderGotchiPageTabs(page, totalPages) {
  const tabs = [];
  for (let i = 0; i < totalPages; i++) {
    tabs.push(i === page ? `[${i + 1}]` : ` ${i + 1} `);
  }
  console.log(`\n  Pages:  ${tabs.join("  ")}`);
}

/** Confirm import of an owned on-chain gotchi (bindOwned is free). */
async function confirmOwnedImport(g) {
  clear();
  title("Owned Aavegotchi");
  console.log(`  Selected  ${formatGotchiLabel(g)}`);
  console.log("  This wallet already owns this gotchi on Base.");
  console.log("  Binding it as a cAavegotchi is free (MetaMask bindOwned, no fee).\n");
  console.log("    1) Mint / bind to cartridge");
  console.log("    2) Go back");
  for (;;) {
    const ans = (await rl.question("\n  Choose [1-2]: ")).trim().toLowerCase();
    if (ans === "1" || ans === "m" || ans === "mint") return true;
    if (ans === "2" || ans === "b" || ans === "back") return false;
    console.log("  pick 1 (mint) or 2 (go back)");
  }
}

function alreadyBoundTokenIds(cartridgeHeroes) {
  const ids = new Set();
  for (const h of cartridgeHeroes || []) {
    if (h?.sourceTokenId != null) ids.add(String(h.sourceTokenId));
    const m = String(h?.id || "").match(/^owned-(\d+)$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Confirm + bind every wallet gotchi not already on the cartridge (free). */
async function mintAllWalletGotchis(wallet, cartridgeId, allGotchis, cartridgeHeroes = []) {
  const bound = alreadyBoundTokenIds(cartridgeHeroes);
  const pending = (allGotchis || []).filter((g) => {
    const id = String(g.gotchiId ?? g.id ?? "");
    return id && !bound.has(id);
  });
  const skipped = (allGotchis || []).length - pending.length;

  clear();
  title("Mint all wallet gotchis");
  console.log(`  wallet gotchis   ${(allGotchis || []).length}`);
  console.log(`  already on cart  ${skipped}`);
  console.log(`  to mint / bind   ${pending.length}  (free — one MetaMask page, batched when the wallet allows)\n`);
  if (!pending.length) {
    console.log("  Nothing left to mint — every wallet gotchi is already a cAavegotchi.");
    await pause();
    return { kind: "mint-all", bound: [], skipped, failed: [] };
  }
  console.log("    1) Mint / bind all pending");
  console.log("    2) Go back");
  for (;;) {
    const ans = (await rl.question("\n  Choose [1-2]: ")).trim().toLowerCase();
    if (ans === "2" || ans === "b" || ans === "back") return null;
    if (ans === "1" || ans === "a" || ans === "all" || ans === "m" || ans === "mint") break;
    console.log("  pick 1 (mint all) or 2 (go back)");
  }

  const ok = [];
  const failed = [];
  console.log("");
  const total = pending.length;
  const byId = new Map(pending.map((g) => [String(g.gotchiId ?? g.id), g]));
  let batch = null;
  try {
    const { bindOwnedBatchToDesk } = await import("./cartridge-mint-sepolia.mjs");
    batch = await withStatusBar(`Binding ${total} gotchis…`, (onProgress) =>
      bindOwnedBatchToDesk([...byId.keys()], { onProgress }),
    );
  } catch (e) {
    console.log(`  · batch bind unavailable (${String(e?.message || e).slice(0, 100)}) — one page per gotchi`);
  }
  if (batch) {
    const via = { contract: "one bindOwnedBatch tx", batch: "one MetaMask batch", sequential: "one confirm each" };
    if (batch.mode) console.log(`  · ${via[batch.mode] || batch.mode}${batch.txHashes.length ? ` · ${batch.txHashes.length} tx` : ""}`);
    for (const tokenId of batch.bound) {
      const g = byId.get(tokenId);
      const heroId = await bindOwnedGotchi(null, tokenId, g, { alreadyBound: true }).catch(() => `owned-${tokenId}`);
      console.log(`  ✓ #${tokenId}${g?.name ? ` "${g.name}"` : ""} → ${heroId}`);
      ok.push({ tokenId, heroId });
    }
    for (const f of batch.failed) {
      const g = byId.get(String(f.tokenId));
      console.log(`  ✗ #${f.tokenId}${g?.name ? ` "${g.name}"` : ""} — ${f.error}`);
      failed.push({ tokenId: String(f.tokenId), error: f.error });
    }
    console.log(`\n  bound ${ok.length}/${total} · skipped ${skipped} · failed ${failed.length}`);
    await syncFleetQuiet();
    await pause();
    return { kind: "mint-all", bound: ok, skipped, failed };
  }

  const bar = new Progress();
  bar.set(0, `minting 0/${total}`);
  for (let i = 0; i < total; i++) {
    const g = pending[i];
    const tokenId = String(g.gotchiId ?? g.id);
    const name = g.name ? ` "${g.name}"` : "";
    const stepLabel = `[${i + 1}/${total}] #${tokenId}${name}`;
    const nextPct = Math.round(((i + 1) / total) * 100);
    try {
      const heroId = await bar.pulse(
        `Binding ${stepLabel}…`,
        () => apiOp("bind-owned", tokenId, g),
        { nextPct },
      );
      bar.set(nextPct, `minted ${i + 1}/${total}`);
      process.stderr.write(`\n  ✓ ${stepLabel} → ${heroId}\n`);
      ok.push({ tokenId, heroId });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 120);
      bar.set(nextPct, `minted ${i + 1}/${total} (${failed.length + 1} failed)`);
      process.stderr.write(`\n  ✗ ${stepLabel} — ${msg}\n`);
      failed.push({ tokenId, error: msg });
    }
  }
  bar.done(`bound ${ok.length}/${total} · skipped ${skipped} · failed ${failed.length}`);
  await syncFleetQuiet();
  await pause();
  return { kind: "mint-all", bound: ok, skipped, failed };
}

/** Pick existing cAavegotchi on cartridge and/or import an on-chain gotchi. */
async function pickHeroOrImportGotchi(wallet, cartridgeId, allGotchis, cartridgeHeroes = []) {
  let view = allGotchis.length > 0 ? "onchain" : "cartridge";
  let cartridge = Array.isArray(cartridgeHeroes) ? [...cartridgeHeroes] : [];
  let page = 0;
  let searchMode = false;
  let searchList = null;

  /** Hide wallet gotchis already bound as owned-<id> / sourceTokenId. */
  const pendingOnChain = () => {
    const bound = alreadyBoundTokenIds(cartridge);
    return (allGotchis || []).filter((g) => {
      const id = String(g.gotchiId ?? g.id ?? "");
      return id && !bound.has(id);
    });
  };

  const activeList = () => {
    if (searchMode && searchList) return searchList;
    return view === "cartridge" ? cartridge : pendingOnChain();
  };

  for (;;) {
    const onChainPending = pendingOnChain();
    const alreadyBoundCount = Math.max(0, (allGotchis || []).length - onChainPending.length);
    if (view === "onchain" && !searchMode && (allGotchis || []).length > 0 && onChainPending.length === 0) {
      view = "cartridge";
      page = 0;
    }
    const items = activeList();
    const totalPages = Math.max(1, Math.ceil(items.length / GOTCHI_PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;
    const startIdx = page * GOTCHI_PAGE_SIZE;
    const slice = items.slice(startIdx, startIdx + GOTCHI_PAGE_SIZE);
    const showPager = !searchMode && items.length > GOTCHI_PAGE_SIZE;

    clear();
    title(view === "cartridge" ? "Cartridge cAavegotchis" : "On-chain gotchis");
    if (searchMode) {
      console.log(`  Search results — ${items.length} match(es)\n`);
    } else if (view === "cartridge") {
      console.log(
        `  ${cartridge.length} cAavegotchi(s) on cartridge` +
          `${showPager ? ` · page ${page + 1}/${totalPages} · ${GOTCHI_PAGE_SIZE}/page` : ""}\n`,
      );
      if (showPager) renderGotchiPageTabs(page, totalPages);
      console.log("");
    } else {
      console.log(
        `  ${onChainPending.length} unbound in wallet` +
          `${alreadyBoundCount ? ` · ${alreadyBoundCount} already owned (hidden)` : ""}` +
          `${showPager ? ` · page ${page + 1}/${totalPages} · ${GOTCHI_PAGE_SIZE}/page` : ""}\n`,
      );
      if (showPager) renderGotchiPageTabs(page, totalPages);
      console.log("");
    }

    if (!slice.length) {
      console.log(
        view === "cartridge"
          ? "  (none yet — mint one or switch to on-chain import)"
          : alreadyBoundCount > 0
            ? "  (all wallet gotchis already on cartridge — switch to [c] or mint new)"
            : "  (none in wallet — switch to cartridge or mint)",
      );
      console.log("");
    }

    slice.forEach((item, i) => {
      const label = view === "cartridge" ? formatCartridgeHeroLabel(item) : formatGotchiLabel(item);
      const tag = view === "cartridge" ? "[cAave]" : "[on-chain]";
      console.log(`    ${String(i + 1).padStart(2)} ) ${label}  ${tag}`);
    });

    console.log("");
    if (showPager) {
      if (page > 0) console.log("    [p] Previous page");
      if (page < totalPages - 1) console.log("    [n] Next page");
      console.log("    [tN] Jump to page tab (e.g. t2)");
    }
    if (!searchMode) {
      if (view === "onchain") {
        console.log(`    [c] Switch to cartridge cAavegotchis (${cartridge.length})`);
      } else {
        console.log(`    [o] Switch to on-chain wallet (${onChainPending.length} unbound)`);
      }
    }
    console.log("    [s] Search by gotchi ID or cAavegotchi id");
    console.log("    [m] Mint new cAavegotchi ($5)");
    if (view === "onchain" && !searchMode && onChainPending.length > 0) {
      console.log(`    [a] Mint all wallet gotchis (${onChainPending.length} pending · free)`);
    }
    if (searchMode) console.log("    [b] Back to full list");
    console.log("    [q] Quit");

    const ans = (await rl.question("\n  Pick [number / c / o / m / a / n / p / s / q]: ")).trim().toLowerCase();

    if (ans === "q" || ans === "quit") quitToTerminal();

    if (ans === "m" || ans === "mint") {
      const heroId = await mintNewGotchi({
        collateralPrompt: "Choose collateral for new cAavegotchi",
        intro: "  Mint a new cAavegotchi for $5.",
      });
      return { kind: "mint", heroId };
    }

    if ((ans === "a" || ans === "all") && view === "onchain" && !searchMode) {
      const result = await mintAllWalletGotchis(wallet, cartridgeId, allGotchis, cartridge);
      if (!result) continue;
      cartridge = (await fetchCartridgeHeroes(cartridgeId)) || cartridge;
      return result;
    }

    if (ans === "c" && view === "onchain" && !searchMode) {
      cartridge = (await fetchCartridgeHeroes(cartridgeId)) || [];
      view = "cartridge";
      page = 0;
      searchMode = false;
      searchList = null;
      continue;
    }

    if (ans === "o" && view === "cartridge" && !searchMode) {
      view = "onchain";
      page = 0;
      searchMode = false;
      searchList = null;
      continue;
    }

    if (ans === "b" && searchMode) {
      searchMode = false;
      searchList = null;
      page = 0;
      continue;
    }

    if (ans === "n" && showPager && page < totalPages - 1) {
      page++;
      continue;
    }

    if (ans === "p" && showPager && page > 0) {
      page--;
      continue;
    }

    const tabMatch = /^t(\d+)$/.exec(ans);
    if (showPager && tabMatch) {
      const tab = Number(tabMatch[1]);
      if (tab >= 1 && tab <= totalPages) {
        page = tab - 1;
        continue;
      }
      console.log(`  page must be 1–${totalPages}`);
      await pause();
      continue;
    }

    if (ans === "s") {
      const raw = (await rl.question("  ID (#gotchi, hero id, or number): ")).trim();
      const id = raw.replace(/^#/, "");
      if (!id) {
        console.log("  enter an id");
        await pause();
        continue;
      }

      if (view === "cartridge") {
        let hit = cartridge.find((h) => h.id === id || String(h.sourceTokenId) === id);
        if (!hit && !/^\d+$/.test(id)) {
          hit = cartridge.find((h) => h.id.includes(id));
        }
        if (!hit) {
          console.log(`  no cAavegotchi match for ${id}`);
          await pause();
          continue;
        }
        searchList = [hit];
        searchMode = true;
        page = 0;
        continue;
      }

      const cartHit = cartridge.find((h) => h.id === id || String(h.sourceTokenId) === id);
      if (cartHit) {
        return { kind: "cartridge", hero: cartHit };
      }
      if (/^\d+$/.test(id)) {
        const found =
          onChainPending.find((g) => String(g.gotchiId) === id) ??
          allGotchis.find((g) => String(g.gotchiId) === id) ??
          (await fetchWalletGotchiById(wallet, id));
        if (!found) {
          console.log(`  #${id} not found in wallet or cartridge`);
          await pause();
          continue;
        }
        if (alreadyBoundTokenIds(cartridge).has(String(found.gotchiId ?? found.id ?? id))) {
          console.log(`  #${id} already on cartridge as owned-${id} — switch to [c] to select it`);
          await pause();
          continue;
        }
        searchList = [found];
        searchMode = true;
        page = 0;
        continue;
      }
      const cartByPrefix = cartridge.find((h) => h.id.includes(id));
      if (cartByPrefix) return { kind: "cartridge", hero: cartByPrefix };
      console.log(`  no match for ${id}`);
      await pause();
      continue;
    }

    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= slice.length) {
      const picked = slice[n - 1];
      if (view === "cartridge") {
        return { kind: "cartridge", hero: picked };
      }
      const ok = await confirmOwnedImport(picked);
      if (!ok) continue;
      return { kind: "onchain", gotchi: picked };
    }

    console.log("  invalid choice");
    await pause();
  }
}

async function pickCollateral(promptText) {
  const options = loadBaseStarterCollaterals();
  if (!options.length) throw new Error("no starter collaterals loaded — check assets/collateral-colors.json");

  console.log(`\n  ${promptText}\n`);
  options.forEach((c, i) => {
    console.log(`    ${String(i + 1).padStart(2)} ) ${c.libraryName.padEnd(10)} (H${c.hauntId})`);
  });
  for (;;) {
    const ans = (await rl.question(`\n  Collateral [1-${options.length}]: `)).trim();
    const n = Number(ans);
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log(`  pick 1–${options.length}`);
  }
}

async function mintNewGotchi({ collateralPrompt, apiOpName = "bind-starter", intro } = {}) {
  title("Mint cAavegotchi");
  console.log(intro ?? "  Mint a cAavegotchi for $5.");
  console.log("  MetaMask bindStarter on Base Sepolia.\n");
  const option = await pickCollateral(collateralPrompt);
  console.log(`\n  Minting (${option.libraryName} · H${option.hauntId})…`);
  const heroId = await apiOp(apiOpName, option);
  console.log(`  ✓ minted ${heroId}`);
  return heroId;
}

async function mintStarterGotchi({ collateralPrompt, apiOpName = "bind-starter" }) {
  return mintNewGotchi({
    collateralPrompt,
    apiOpName,
    intro: "  No gotchis found. Mint a cAavegotchi for $5.",
  });
}

async function resolveHeroes(wallet, cartridgeId) {
  let heroes = await fetchCartridgeHeroes(cartridgeId);
  if (heroes.length > 0) {
    console.log(`\n  ✓ ${heroes.length} cAavegotchi(s) on cartridge`);
    return heroes;
  }

  console.log("\n  No cAavegotchis on cartridge yet.");
  let onChain = [];
  try {
    onChain = await withStatusBar("Loading gotchis from subgraph…", (onStatus) =>
      fetchWalletGotchis(wallet, { onStatus }),
    );
  } catch (e) {
    console.log(`  Subgraph: ${e.message || e}`);
  }

  if (onChain.length === 0) {
    console.log("  Subgraph unreachable or empty — checked Base RPC too.");
  }

  // Re-fetch cartridge heroes — API may have been flaky on first call.
  const cartridgeHeroes = (await fetchCartridgeHeroes(cartridgeId)) || [];

  if (onChain.length > 0 || cartridgeHeroes.length > 0) {
    if (onChain.length > 0) {
      const via = onChain.source === "base-rpc" ? "Base RPC" : "subgraph";
      console.log(`  Found ${onChain.length} Aavegotchi(s) on Base (${via}) for ${shortAddr(wallet)}.`);
    }
    if (cartridgeHeroes.length > 0) {
      console.log(`  Found ${cartridgeHeroes.length} cAavegotchi(s) on cartridge.`);
    }
    const pick = await pickHeroOrImportGotchi(wallet, cartridgeId, onChain, cartridgeHeroes);
    if (!pick) return heroes;
    if (pick.kind === "cartridge") {
      console.log(`\n  ✓ using cAavegotchi ${pick.hero.id}`);
      heroes = await fetchCartridgeHeroes(cartridgeId);
      return heroes.length ? heroes : [pick.hero];
    }
    if (pick.kind === "mint") {
      heroes = await fetchCartridgeHeroes(cartridgeId);
      return heroes;
    }
    if (pick.kind === "mint-all") {
      heroes = await fetchCartridgeHeroes(cartridgeId);
      return heroes;
    }
    console.log(`\n  Binding owned gotchi #${pick.gotchi.gotchiId} (free)…`);
    const heroId = await apiOp("bind-owned", pick.gotchi.gotchiId, pick.gotchi);
    console.log(`  ✓ bound ${heroId}`);
    heroes = await fetchCartridgeHeroes(cartridgeId);
    return heroes;
  }

  await mintStarterGotchi({ collateralPrompt: "Choose collateral for orchestrator gotchi" });
  heroes = await fetchCartridgeHeroes(cartridgeId);
  return heroes;
}

async function pickOrchestrator(heroes) {
  if (heroes.length === 1) return heroes[0].id;
  const pick = await choose(
    "Select orchestrator avatar",
    heroes.map((h) => ({ label: h.id, id: h.id })),
  );
  return pick?.id ?? heroes[0].id;
}

async function syncFleetQuiet() {
  try {
    const { syncFleet } = await import("./openclaw-fleet.mjs");
    await syncFleet({ quiet: true });
  } catch {}
}


const TTS_STATE = `${ROOT}/sessions/.tts.json`;
const TUI_PREFS = `${ROOT}/sessions/.tui-prefs.json`;
const DEFAULT_READ_SPEED = 1.05;
const READ_SPEED_PRESETS = [
  { key: "slow", label: "Slow", readSpeed: 0.85 },
  { key: "normal", label: "Normal", readSpeed: 1.05 },
  { key: "fast", label: "Fast", readSpeed: 1.25 },
  { key: "faster", label: "Faster", readSpeed: 1.45 },
];

function readJsonFile(path, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

function writeJsonFile(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function loadTtsSettings() {
  const s = readJsonFile(TTS_STATE, { enabled: false, persona: "gotchi", readSpeed: DEFAULT_READ_SPEED });
  const readSpeed = typeof s.readSpeed === "number" && s.readSpeed > 0 ? s.readSpeed : DEFAULT_READ_SPEED;
  return { enabled: s.enabled === true, persona: s.persona || "gotchi", readSpeed };
}

function saveTtsSettings(patch) {
  const raw = readJsonFile(TTS_STATE, { enabled: false, persona: "gotchi", readSpeed: DEFAULT_READ_SPEED });
  writeJsonFile(TTS_STATE, { ...raw, ...patch });
}

function loadTuiPrefs() {
  const s = readJsonFile(TUI_PREFS, { mouse: true, replay: true });
  return { mouse: s.mouse !== false, replay: s.replay !== false };
}

function saveTuiPrefs(patch) {
  writeJsonFile(TUI_PREFS, { ...loadTuiPrefs(), ...patch });
}

function speedLabel(n) {
  const hit = READ_SPEED_PRESETS.find((p) => p.readSpeed === n);
  return hit ? `${hit.label} (${n})` : String(n);
}

/** abra may prompt (Touch ID / hidden input) — cockpit readline must let go of the tty. */
function withTty(fn) {
  try {
    rl.pause();
  } catch {}
  try {
    return fn();
  } finally {
    try {
      rl.resume();
    } catch {}
  }
}

async function githubMenu() {
  const gh = await import("./github-connect.mjs");
  for (;;) {
    clear();
    title("GitHub");
    console.log("  One token in abra (gotchibot / GOTCHIBOT_GITHUB_PAT) — the GitHub MCP");
    console.log("  and repo tools read it from there. The value is never shown or saved elsewhere.\n");
    const state = gh.loadGithubState();
    const inAbra = gh.abraHasToken();
    const ghUser = gh.ghLogin();
    console.log(`  connected  ${gh.githubSummary()}`);
    if (state?.scopes?.length) console.log(`  scopes     ${state.scopes.join(", ")}`);
    console.log(
      `  abra       ${inAbra ? "token stored" : inAbra === false ? "no token" : "(abra unavailable)"}`,
    );
    console.log(`  gh CLI     ${ghUser ? `logged in as @${ghUser}` : "not logged in"}`);
    hr();

    const opts = [];
    if (ghUser) opts.push({ key: "gh", label: `Connect with gh CLI login (@${ghUser})` });
    opts.push({ key: "token", label: "Connect with a personal access token" });
    if (inAbra) {
      opts.push({ key: "test", label: "Test connection" });
      opts.push({ key: "disconnect", label: "Disconnect (remove token from abra)" });
    }
    opts.push({ key: "back", label: "Back to settings" });
    const pick = await choose("GitHub", opts);
    if (!pick || pick.key === "back") return;

    let r;
    if (pick.key === "gh") {
      console.log("\n  Copying the gh token into abra (approve Touch ID if asked)…");
      r = withTty(() => gh.connectWithGh());
    } else if (pick.key === "token") {
      console.log(`\n  Opening GitHub token page (scopes: repo, read:org, workflow)…`);
      console.log(`  ${gh.TOKEN_URL}`);
      try {
        spawn("open", [gh.TOKEN_URL], { stdio: "ignore", detached: true }).unref();
      } catch {
        /* user can open manually */
      }
      console.log("  Generate it, copy it, then paste at abra's hidden prompt below.\n");
      r = withTty(() => gh.connectWithToken());
    } else if (pick.key === "test") {
      console.log("\n  Checking the stored token with GitHub…");
      r = withTty(() => gh.verifyGithub());
    } else if (pick.key === "disconnect") {
      const ans = (await rl.question("  Remove the GitHub token from abra? [y/N]: ")).trim().toLowerCase();
      if (ans !== "y" && ans !== "yes") continue;
      r = withTty(() => gh.disconnectGithub());
      if (r.ok) {
        console.log(r.removed ? "  ✓ disconnected" : "  ✓ nothing was stored");
        await pause();
        continue;
      }
    }
    if (r?.ok) {
      console.log(`  ✓ connected as @${r.login}${r.scopes?.length ? ` · ${r.scopes.join(", ")}` : ""}`);
    } else if (r) {
      console.log(`  ✗ ${r.error}`);
    }
    await pause();
  }
}

async function settingsMenu() {
  for (;;) {
    const tts = loadTtsSettings();
    const tui = loadTuiPrefs();
    const { githubSummary } = await import("./github-connect.mjs");
    let ipfsOn = false;
    try {
      const { isIpfsStorageEnabled } = await import("./project-context.mjs");
      ipfsOn = isIpfsStorageEnabled();
    } catch {
      ipfsOn = false;
    }
    clear();
    title("Settings");
    console.log(`  Voice         ${tts.enabled ? "on" : "off"}`);
    console.log(`  Read speed    ${speedLabel(tts.readSpeed)}`);
    console.log(`  Mouse         ${tui.mouse ? "on" : "off"}  (OpenCode)`);
    console.log(`  Chat replay   ${tui.replay ? "on" : "off"}  (keeps history scrollable)`);
    console.log(`  Project store local always · IPFS ${ipfsOn ? "on" : "off"}`);
    console.log(`  GitHub        ${githubSummary()}`);
    hr();

    const pick = await choose("Settings", [
      { key: "voice", label: `Voice — ${tts.enabled ? "on" : "off"}` },
      { key: "speed", label: `Read speed — ${speedLabel(tts.readSpeed)}` },
      { key: "test", label: "Test voice (speak a short line at current speed)" },
      { key: "mouse", label: `OpenCode mouse — ${tui.mouse ? "on" : "off"}` },
      { key: "replay", label: `Chat replay — ${tui.replay ? "on" : "off"}` },
      {
        key: "ipfs",
        label: `IPFS storage — ${ipfsOn ? "on" : "off"}  (local default; turn on when you have a pin)`,
      },
      { key: "github", label: `GitHub — ${githubSummary()}` },
      { key: "back", label: "Back to cockpit" },
    ]);
    if (!pick || pick.key === "back") return;

    if (pick.key === "github") {
      await githubMenu();
      continue;
    }

    if (pick.key === "voice") {
      saveTtsSettings({ enabled: !tts.enabled });
      continue;
    }

    if (pick.key === "speed") {
      const speedPick = await choose(
        "Read speed",
        READ_SPEED_PRESETS.map((p) => ({
          key: p.key,
          label: `${p.label} (${p.readSpeed})`,
          readSpeed: p.readSpeed,
        })),
      );
      if (speedPick?.readSpeed) saveTtsSettings({ readSpeed: speedPick.readSpeed });
      continue;
    }

    if (pick.key === "test") {
      console.log("\n  Speaking…");
      try {
        const r = spawnSync(
          process.execPath,
          [
            `${ROOT}/scripts/tts.mjs`,
            "speak",
            "Hi fren! This is the current read speed.",
            "--persona",
            "gotchi",
            "--force",
          ],
          { cwd: ROOT, stdio: "ignore", timeout: 60_000 },
        );
        if (r.status !== 0) console.log("  (voice test failed — TTS may be unavailable)");
        else console.log("  ✓ done");
      } catch {
        console.log("  (voice test failed — TTS may be unavailable)");
      }
      await pause();
      continue;
    }

    if (pick.key === "mouse") {
      saveTuiPrefs({ mouse: !tui.mouse });
      continue;
    }

    if (pick.key === "replay") {
      saveTuiPrefs({ replay: !tui.replay });
      continue;
    }

    if (pick.key === "ipfs") {
      try {
        const { saveProjectStoragePrefs, isIpfsStorageEnabled } = await import("./project-context.mjs");
        const next = !isIpfsStorageEnabled();
        saveProjectStoragePrefs({ ipfsEnabled: next });
        console.log(`\n  ✓ IPFS storage → ${next ? "on" : "off"}`);
        if (next) {
          console.log("  Local desk path stays default. After pin:");
          console.log("    node ./scripts/project-context.mjs storage-set <slug> <cid>");
        } else {
          console.log("  Checkpoints stay local-only (no stateUri until IPFS is on + pinned).");
        }
      } catch (e) {
        console.log(`\n  ✗ ${e?.message || e}`);
      }
      await pause();
      continue;
    }
  }
}


async function viewBotInbox() {
  clear();
  title("Bot inbox");
  console.log("  Internal mail — iMessage thread (not AgentMail). Address UserDefault only.");
  console.log("  j/k select · Enter read · a archive · u unread · t filter · q back\n");
  try {
    rl.pause();
  } catch {}
  let r;
  try {
    r = spawnSync(process.execPath, [`${ROOT}/scripts/bot-inbox-tui.mjs`], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
  } finally {
    try {
      rl.resume();
    } catch {}
  }
  if (r?.status !== 0 && r?.status != null) {
    clear();
    title("Bot inbox");
    console.log("  TUI unavailable — unread dump:\n");
    const dump = runAbraNode("scripts/bot-inbox.mjs", ["unread", "--to", "userdefault"]);
    if (dump.stdout) process.stdout.write(dump.stdout);
    if (dump.stderr) process.stderr.write(dump.stderr);
    await pause();
  }
}

async function viewKanban() {
  clear();
  title("Kanban");
  console.log("  Opening 3-pane board (categories · details · logs)…");
  console.log("  q quit · j/k select · Space collapse · Enter session\n");
  // runAbraNode pipes stdout — that blanks the TUI and looks "stuck".
  // Inherit the real tty, and pause cockpit readline while the child runs.
  const script = `${ROOT}/scripts/gotchi-kanban.mjs`;
  try {
    rl.pause();
  } catch {}
  let r;
  try {
    r = spawnSync(process.execPath, [script, "--tui"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
  } finally {
    try {
      rl.resume();
    } catch {}
  }
  // 10 = user picked a seat and we respawned chat into that agent
  if (r?.status === 10) {
    if (process.env.GOTCHIBOT_IN_CHAT_PANE === "1") {
      // chat-pane.sh continues after cockpit exits
      return;
    }
    // Standalone cockpit: hand off to chat pane
    try {
      rl.close();
    } catch {}
    const chatPane = `${ROOT}/scripts/chat-pane.sh`;
    spawnSync(chatPane, [], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, GOTCHIBOT_SKIP_ONBOARDING: "1", GOTCHIBOT_SKIP_COCKPIT: "1" },
    });
    process.exit(0);
  }
  if (r?.status !== 0 && r?.status != null) {
    clear();
    title("Kanban");
    console.log("  TUI unavailable — plain board:\n");
    const dump = runAbraNode("scripts/gotchi-kanban.mjs", ["--once"]);
    if (dump.stdout) process.stdout.write(dump.stdout);
    if (dump.stderr) process.stderr.write(dump.stderr);
    if (dump.status !== 0 && !dump.stdout?.trim()) {
      console.log(`  ✗ kanban failed (exit ${dump.status ?? "?"})`);
    }
    await pause();
  }
}

async function viewAgentRoster() {
  clear();
  title("OpenClaw agent roster");
  console.log("  Scanning MBP + iMac sessions…\n");
  const r = runAbraNode("scripts/agent-focus.mjs", ["roster"]);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr && r.status !== 0) process.stderr.write(r.stderr);
  if (r.status !== 0 && !r.stdout?.trim()) {
    console.log(`  ✗ roster scan failed (exit ${r.status ?? "?"})`);
    await pause();
    return;
  }

  const follow = await choose("Roster", [
    { key: "back", label: "Back to cockpit" },
    { key: "export", label: "Export to CSV file" },
  ]);
  if (follow?.key === "export") {
    await exportAgentRosterCsv();
  }
}

async function viewHubStatus() {
  clear();
  title("Hub status");
  console.log("  Probing always-on fleet host (Tailscale)…\n");
  const r = runAbraNode("scripts/hub-status.mjs", ["--live"]);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !r.stdout?.trim()) {
    console.log(`  ✗ hub status failed (exit ${r.status ?? "?"})`);
  }
  await pause();
}

/** True when desk already reaches the always-on Hub (cached live probe). */
function isHubUpQuick() {
  try {
    const cache = JSON.parse(readFileSync(`${ROOT}/sessions/.imac-status-cache.json`, "utf8"));
    if (cache.remoteOk === true) return true;
    if (typeof cache.barLine === "string" && /\bHub:\s*up\b/i.test(cache.barLine)) return true;
  } catch {
    /* no cache */
  }
  return false;
}

/** New / unconfigured desk: no hub host wired yet. */
function isHubNetworkUnset() {
  const envHost = ["GOTCHIBOT_HUB_HOST", "REMOTE_HOST", "GOTCHIBOT_REMOTE_HOST"]
    .map((k) => process.env[k])
    .find((v) => v && String(v).trim());
  if (envHost) return false;
  try {
    const cfg = JSON.parse(readFileSync(`${ROOT}/config/hub-bridge.json`, "utf8"));
    const host = String(cfg.host || "").trim();
    if (!host || /YOUR-HUB-HOSTNAME/i.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

async function runHubNetworkSetup() {
  clear();
  try {
    rl.pause();
  } catch {}
  try {
    spawnSync(process.execPath, [`${ROOT}/scripts/hub-network.mjs`, "setup"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
  } finally {
    try {
      rl.resume();
    } catch {}
  }
  await pause();
}

async function implementGotchiHubNetwork() {
  clear();
  title("Fleet ops over SSH (advanced)");
  console.log("  Remote spawns, deploys and Hub status over Tailscale SSH + abra keys.");
  console.log("  Chats and pairing don't need this — they use \"Set up Hub network\".\n");
  console.log("  Steps:");
  console.log("    1. Hub Mac on Tailscale (MagicDNS name)");
  console.log("    2. config/hub-bridge.json host = that name (seeded below if missing)");
  console.log("    3. abra project gotchibot holds REMOTE_HOST / SSH key");
  console.log("    4. Probe: ./scripts/gotchibot hub status\n");

  try {
    const { ensureLocalConfig } = await import("./ensure-local-config.mjs");
    const r = ensureLocalConfig(ROOT, { quiet: true });
    if (r?.created?.length) {
      console.log(`  · seeded ${r.created.length} config file(s)`);
    } else {
      console.log("  · local config already present");
    }
  } catch (e) {
    console.log(`  · ensure-local-config: ${e?.message || e}`);
  }

  try {
    const cfgPath = `${ROOT}/config/hub-bridge.json`;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      console.log(`  · hub-bridge host  ${cfg.host || "(unset)"}`);
      if (/YOUR-HUB-HOSTNAME/i.test(String(cfg.host || ""))) {
        console.log("  · Edit config/hub-bridge.json — replace YOUR-HUB-HOSTNAME with MagicDNS.");
      }
    }
  } catch {
    /* optional */
  }

  console.log("\n  Probing hub…");
  const bar = new Progress();
  bar.set(10, "Hub network probe…");
  let probe;
  try {
    probe = await bar.pulse(
      "Hub status (waiting)…",
      () => runAbraNode("scripts/hub-status.mjs", ["--json", "--live"]),
      { nextPct: 90 },
    );
  } catch (e) {
    bar.fail("Hub probe — failed");
    console.log(`  ✗ ${e?.message || e}`);
    await pause();
    return;
  }

  let up = false;
  try {
    const j = JSON.parse(String(probe?.stdout || "{}"));
    up = j?.ssh?.ok === true || j?.remoteOk === true;
    if (probe?.stdout) {
      // Prefer human dashboard after json probe
    }
  } catch {
    up = probe?.status === 0;
  }

  if (up) {
    bar.done("Hub network reachable");
    console.log("  ✓ Hub is up — cockpit will show Hub status / Hub infra next time.\n");
    const human = runAbraNode("scripts/hub-status.mjs", ["--live"]);
    if (human.stdout) process.stdout.write(human.stdout);
  } else {
    bar.fail("Hub not reachable yet");
    if (probe?.stdout) process.stdout.write(probe.stdout);
    if (probe?.stderr) process.stderr.write(probe.stderr);
    console.log("\n  Still down — check Tailscale, hub power, and:");
    console.log("    abra run gotchibot -- ./scripts/gotchibot hub status");
    console.log("    abra run gotchibot -- ./scripts/gotchibot hub doctor");
  }
  await pause();
}

async function viewHubInfra() {
  clear();
  title("Hub infra");
  console.log("  Docker + subgraph + tunnel on Hub (via SSH)…\n");
  const r = runAbraNode("scripts/hub-status.mjs", ["--infra"]);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !r.stdout?.trim()) {
    console.log(`  ✗ hub infra failed (exit ${r.status ?? "?"})`);
  }
  await pause();
}

async function exportAgentRosterCsv() {
  clear();
  title("Export roster");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultPath = `${ROOT}/sessions/roster-${stamp}.csv`;
  console.log(`  Default file:\n  ${defaultPath}\n`);
  const raw = (await rl.question("  CSV path [Enter = default]: ")).trim();
  const outPath = raw || defaultPath;
  console.log("\n  Scanning + writing CSV…");
  const args = ["roster", "--csv", outPath];
  const r = runAbraNode("scripts/agent-focus.mjs", args);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr && r.status !== 0) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.log(`\n  ✗ export failed (exit ${r.status ?? "?"})`);
  } else {
    try {
      const copied = spawnSync(process.execPath, [`${ROOT}/scripts/clipboard-copy.mjs`, outPath], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (copied.status === 0) {
        console.log(`  ✓ ${(copied.stdout || "").trim() || "path copied to clipboard"}`);
      }
    } catch {
      /* clipboard optional */
    }
  }
  await pause();
}

async function importOrChooseGotchi(wallet, cartridgeId) {
  let onChain = [];
  try {
    onChain = await withStatusBar("Loading on-chain gotchis…", (onStatus) => fetchWalletGotchis(wallet, { onStatus }));
  } catch (e) {
    console.log(`  ${e.message || e}`);
  }
  let cartridgeHeroes = [];
  try {
    cartridgeHeroes = await withStatusBar("Loading cartridge cAavegotchis…", () =>
      fetchCartridgeHeroes(cartridgeId),
    );
  } catch (e) {
    console.log(`  ${e.message || e}`);
    cartridgeHeroes = [];
  }
  const pick = await pickHeroOrImportGotchi(wallet, cartridgeId, onChain, cartridgeHeroes || []);
  if (!pick) return;
  if (pick.kind === "cartridge") {
    console.log(`\n  ✓ selected cAavegotchi ${pick.hero.id}`);
    await assignAsOrchestratorIfFirst(pick.hero.id, wallet, cartridgeId);
  } else if (pick.kind === "mint") {
    console.log(`\n  ✓ minted ${pick.heroId}`);
    await assignAsOrchestratorIfFirst(pick.heroId, wallet, cartridgeId);
    await syncFleetQuiet();
  } else if (pick.kind === "mint-all") {
    console.log(
      `\n  ✓ mint-all done — bound ${pick.bound.length}, skipped ${pick.skipped}, failed ${pick.failed.length}`,
    );
    const first = pick.bound?.[0];
    if (first) await assignAsOrchestratorIfFirst(first, wallet, cartridgeId);
  } else {
    console.log(`\n  Binding owned gotchi #${pick.gotchi.gotchiId} (free)…`);
    const heroId = await apiOp("bind-owned", pick.gotchi.gotchiId, pick.gotchi);
    console.log(`  ✓ bound ${heroId}`);
    await assignAsOrchestratorIfFirst(heroId, wallet, cartridgeId);
    await syncFleetQuiet();
  }
  await pause();
}


async function startMeetingMenu(heroes) {
  clear();
  title("Start meeting");
  let meet;
  try {
    meet = await import("./gotchi-meet.mjs");
  } catch (e) {
    console.log(`  ✗ failed to load meeting room: ${e.message || e}`);
    await pause();
    leaveMeetGalleryLayout();
    return false;
  }
  const open = meet.loadCurrentMeeting();
  if (open) {
    console.log(`  A meeting is already open: ${open.id}`);
    console.log(`  topic  ${open.topic || "—"}`);
    console.log("  Resume to rejoin, or end first: ./scripts/gotchi-meet.mjs end\n");
    const next = await choose("Meeting", [
      { key: "resume", label: "Resume current meeting" },
      { key: "end", label: "End current meeting, then start a new one" },
      { key: "back", label: "Back to cockpit" },
    ]);
    if (!next || next.key === "back") {
      leaveMeetGalleryLayout();
      return false;
    }
    if (next.key === "resume") {
      console.log(`\n  Meeting ${open.id} is open.`);
      console.log('  In meet room: type a message · ,/. page · /end');
      return true;
    }
    if (next.key !== "end") {
      leaveMeetGalleryLayout();
      return false;
    }
    try {
      await meet.endMeeting();
      console.log("  ✓ ended");
    } catch (e) {
      console.log(`  ✗ ${e.message || e}`);
      await pause();
      leaveMeetGalleryLayout();
      return false;
    }
  }

  const kindPick = await choose("What kind of meeting?", [
    { key: "meeting", label: "Meeting — pick a topic (current flow)" },
    { key: "morning", label: "Morning recap — wake agents, present yesterday → today's goals" },
    { key: "back", label: "Back to cockpit" },
  ]);
  if (!kindPick || kindPick.key === "back") {
    leaveMeetGalleryLayout();
    return false;
  }

  const isMorning = kindPick.key === "morning";
  const topicDefault = isMorning ? "morning meeting" : "Untitled meeting";
  let topic = topicDefault;
  if (!isMorning) {
    topic = (await rl.question("  Topic (Enter for untitled): ")).trim() || topicDefault;
  }

  let meeting;
  try {
    meeting = await meet.startMeeting(topic, {
      kind: isMorning ? "morning-recap" : "meeting",
    });
  } catch (e) {
    console.log(`\n  ✗ ${e.message || e}`);
    await pause();
    leaveMeetGalleryLayout();
    return false;
  }
  console.log(`\n  ✓ meeting ${meeting.id}`);
  console.log(`  kind   ${meeting.kind || "meeting"}`);
  console.log(`  topic  ${meeting.topic}`);

  if (isMorning) {
    console.log("  Morning meeting: inviting all cartridge gotchis…\n");
    try {
      const r = await meet.inviteAllParticipants();
      for (const p of r.invited) {
        console.log(`  ✓ invited ${p.id} (${p.name || p.role})`);
      }
      for (const id of r.skipped) {
        console.log(`  · skipped ${id}`);
      }
      for (const e of r.errors) {
        console.log(`  ✗ error ${e.id}  ${e.error}`);
      }
      console.log(
        `  summary invited ${r.invited.length}  skipped ${r.skipped.length}  errors ${r.errors.length}`,
      );
    } catch (e) {
      console.log(`  ✗ invite all: ${e.message || e}`);
    }

    const final = meet.loadCurrentMeeting() || meeting;
    console.log(`\n  Morning meeting ${final.id} is open.`);
    console.log("  Next (orch / Desk):");
    console.log("    ./scripts/gotchibot meet morning collect --host imac");
    console.log("    ./scripts/gotchibot meet morning present");
    console.log("    # after Q&A for current agent:");
    console.log("    ./scripts/gotchibot meet morning next");
    console.log("  In meet room: @HERO questions · /colabo … · /recap-next · /end");
    return true;
  }

  console.log("  Invite cAavegotchis into the room (optional).\n");

  for (;;) {
    meeting = meet.loadCurrentMeeting() || meeting;
    const inRoom = new Set((meeting.participants || []).map((p) => p.id));
    const available = (heroes || []).filter((h) => h?.id && !inRoom.has(h.id));
    if (!available.length) {
      console.log("  (no other cartridge heroes to invite)");
      break;
    }
    const options = [
      ...available.map((h) => ({
        key: h.id,
        id: h.id,
        label: `${h.id}${h.collateral ? ` · ${h.collateral}` : ""}${h.name ? ` · ${h.name}` : ""}`,
      })),
      { key: "all", label: "Invite all gotchis" },
      { key: "done", label: "Done inviting" },
    ];
    const pick = await choose("Invite who?", options);
    if (!pick || pick.key === "done") break;
    if (pick.key === "all") {
      try {
        const r = await meet.inviteAllParticipants();
        for (const p of r.invited) {
          console.log(`  ✓ invited ${p.id} (${p.name || p.role})`);
        }
        for (const id of r.skipped) {
          console.log(`  · skipped ${id}`);
        }
        for (const e of r.errors) {
          console.log(`  ✗ error ${e.id}  ${e.error}`);
        }
        console.log(
          `  summary invited ${r.invited.length}  skipped ${r.skipped.length}  errors ${r.errors.length}`,
        );
      } catch (e) {
        console.log(`  ✗ ${e.message || e}`);
      }
      continue;
    }
    try {
      const r = await meet.inviteParticipant(pick.id);
      console.log(`  ✓ invited ${r.participant.id} (${r.participant.name || r.participant.role})`);
    } catch (e) {
      console.log(`  ✗ ${e.message || e}`);
    }
  }

  const final = meet.loadCurrentMeeting() || meeting;
  if (!final) {
    console.log("  (no open meeting)");
    await pause();
    leaveMeetGalleryLayout();
    return false;
  }

  console.log(`\n  Meeting ${final.id} is open.`);
  console.log("  In meet room: type a message · ,/. page · /end · /colabo …");
  return true;
}

async function runSealedCartMintMenu(wallet, { abraSnap = null } = {}) {
  const haveAbra = Boolean(abraSnap?.cartridgeId || abraSnap?.verified);
  title(haveAbra ? "Mint GotchiBot sealed cart · Base Sepolia" : "Mint sealed cart · Base Sepolia");
  console.log("  MetaMask signs the txs (no private key on the desk).");
  console.log(`  Concierge twin: ${CONCIERGE_MINT_URL}`);
  if (haveAbra) {
    console.log(
      `  Abra cart   already verified${abraSnap.cartridgeId ? ` · #${abraSnap.cartridgeId}` : ""} — mint GotchiBot next.`,
    );
  }
  console.log("");

  let productKey = "gotchibot";
  if (!haveAbra) {
    const productPick = await choose("What to mint?", [
      { key: "gotchibot", label: "GotchiBot sealed cart (nested license · tier)" },
      { key: "abra", label: "Abracadabra sealed soulbound cart" },
      { key: "bundle", label: "Bundle — Abra + GotchiBot (2 txs)" },
      { key: "back", label: "Back" },
    ]);
    if (!productPick || productPick.key === "back") return null;
    productKey = productPick.key;
  }

  let tier = "standard";
  if (productKey === "gotchibot" || productKey === "bundle") {
    const tierPick = await choose("GotchiBot tier", [
      { key: "golden", label: "Golden · $20" },
      { key: "silver", label: "Silver · $15" },
      { key: "standard", label: "Standard · $10" },
      { key: "back", label: "Back" },
    ]);
    if (!tierPick || tierPick.key === "back") return null;
    tier = tierPick.key;
  }

  const payPick = await choose("Pay with", [
    { key: "usdc", label: "USDC" },
    { key: "ghst", label: "GHST" },
    { key: "back", label: "Back" },
  ]);
  if (!payPick || payPick.key === "back") return null;

  try {
    const { quoteMint } = await import("./cartridge-mint-sepolia.mjs");
    const q = await quoteMint({
      product: productKey,
      tier,
      pay: payPick.key,
    });
    console.log("");
    for (const leg of q.legs) {
      console.log(`  · ${leg.product}${leg.tier ? `/${leg.tier}` : ""}  ${leg.spendLabel}`);
    }
    hr();
    console.log("  Transaction recipe");
    console.log(`  chain     Base Sepolia (84532)`);
    console.log(`  wallet    ${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    console.log(`  product   ${q.product}${q.product !== "abra" && q.tier ? ` · ${q.tier}` : ""}`);
    console.log(`  pay       ${q.pay.toUpperCase()}`);
    console.log(`  steps     ${q.legs.length} (approve spend + mint each)`);
    let totalUsdc = 0n;
    let totalGhstLabel = null;
    for (const leg of q.legs) {
      const to = leg.minter ? `${leg.minter.slice(0, 6)}…${leg.minter.slice(-4)}` : "(minter?)";
      console.log(`  · ${leg.product}${leg.tier ? `/${leg.tier}` : ""}`);
      console.log(`      call   ${leg.call}`);
      console.log(`      to     ${to}`);
      console.log(`      spend  ${leg.spendLabel}`);
      if (q.pay === "usdc" && leg.spend) totalUsdc += BigInt(leg.spend);
      else if (q.pay === "ghst") totalGhstLabel = "see legs";
    }
    if (q.pay === "usdc") {
      const dollars = Number(totalUsdc) / 1e6;
      console.log(`  total     ${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)} USDC`);
    } else if (totalGhstLabel) {
      console.log(`  total     ${q.legs.map((l) => l.spendLabel).join(" + ")}`);
    }
    console.log(`  note      MetaMask will prompt per approve / mint tx`);
  } catch (e) {
    console.log(`\n  ✗ ${e?.message || e}`);
    console.log(`  Fix minter addresses or mint at ${CONCIERGE_MINT_URL}`);
    await pause();
    return null;
  }

  const ans = (await rl.question("\n  Type YES to open MetaMask mint, anything else cancels: ")).trim();
  if (ans.toUpperCase() !== "YES") {
    console.log("  Cancelled.");
    await pause();
    return null;
  }

  console.log("\n  Opening mint page…");
  try {
    const { runCartridgeMint } = await import("./cartridge-mint-sepolia.mjs");
    const out = await runCartridgeMint({
      product: productKey,
      tier,
      pay: payPick.key,
      quote: false,
      json: false,
    });
    const nextId = out?.snap?.gbot?.cartridgeId || null;
    if (nextId) {
      console.log(`\n  ✓ GotchiBot cartridge #${nextId}`);
      if (out?.opened) console.log("  ✓ Cart opened on-chain");
      else if (out?.snap?.gbot?.portalStatus === 1) {
        console.log("  · Still sealed — re-run mint cart to finish open, or Concierge");
      }
    }
    await pause();
    return nextId;
  } catch (e) {
    console.log(`\n  ✗ ${e?.message || e}`);
    console.log(`  Concierge: ${CONCIERGE_MINT_URL}`);
    await pause();
    return null;
  }
}

let cockpitReadyMarked = false;

async function mainMenu(wallet, cartridgeId) {
  for (;;) {
    clear();
    console.log(readWelcomeArt(12));
    const [heroes, abraRead] = await Promise.all([
      fetchDeskHeroes(wallet, cartridgeId),
      readAbraCartridgeSepolia(wallet).then(
        (snap) => ({ snap }),
        (e) => ({ error: e }),
      ),
    ]);
    const orchId = await resolveValidOrchestratorId(wallet, cartridgeId, heroes);
    const ob = { ...loadOnboarding(), orchestratorHeroId: orchId };
    const orch = orchId ?? "(none)";
    const abraSnap = abraRead.snap ?? null;
    const abraLine = abraRead.error
      ? `(read failed: ${abraRead.error?.message || abraRead.error})`
      : formatAbraCartLine(abraSnap);

    // Sepolia desk needs a GotchiBot cart before the full cockpit — open mint UI.
    // (Abra may already be minted; mint menu still offers Abra / Bundle / GBOT.)
    const needsGotchiBotCart = !cartridgeId;

    const project = currentProjectSlug();
    title("GotchiBot cockpit");
    console.log(`  wallet      ${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    console.log(
      `  cartridge   ${
        cartridgeId
          ? `${cartridgeId} (Base)`
          : "(none — mint on Base)"
      }`,
    );
    console.log(`  abra cart   ${abraLine}`);
    if (heroes.length === 0 && orchId) {
      console.log(`  roster      0 on-chain · desk orch ${orchId} (pin only — mint collateral for on-chain)`);
    } else {
      console.log(`  roster      ${heroes.length} cAavegotchi(s)`);
    }
    console.log(`  orchestrator ${orch}`);
    try {
      const activeLine = readFileSync(`${ROOT}/sessions/.desk-active.line`, "utf8").trim();
      if (activeLine) console.log(`  active      ${activeLine}`);
    } catch {
      /* snapshot not published yet */
    }
    console.log(`  project     ${project || "(none — select local · Base)"}`);
    if (project) {
      const { loadRepo, formatRepo } = await import("./project-context.mjs");
      const repo = loadRepo(project);
      if (repo) console.log(`  repo        ${formatRepo(repo)}`);
    }
    if (needsGotchiBotCart) {
      const haveAbra = Boolean(abraSnap && abraSnap.cartridgeId);
      console.log(
        haveAbra
          ? `  next        mint GotchiBot sealed cart · or ${CONCIERGE_MINT_URL}`
          : `  next        mint sealed cart (Abra + GotchiBot) · or ${CONCIERGE_MINT_URL}`,
      );
      hr();
      const nextId = await runSealedCartMintMenu(wallet, { abraSnap });
      if (nextId) cartridgeId = nextId;
      else quitToTerminal();
      continue;
    }

    // Cart ready → mint cAavegotchi first, then optionally set orch.
    if (cartridgeId && !orchId) {
      console.log(`  next        mint cAavegotchi · then set orch`);
      hr();
      const heroId = await runFirstOrchMintMenu(wallet, cartridgeId);
      if (!heroId) quitToTerminal();
      continue;
    }

    // New nest desk: need a current project before the full cockpit.
    if (cartridgeId && orchId && !project) {
      console.log(`  next        select or create a project`);
      hr();
      await selectProjectMenu({ freshInstall: true });
      if (!currentProjectSlug()) {
        console.log("  · no project selected yet — pick or create one to continue");
        await pause();
      }
      continue;
    }
    const net = (await import("./hub-network.mjs")).hubNetworkSummary();
    if (!ob.hubNetworkAsked && !net.deskPaired && !net.hubInstalled) {
      console.log(`  next        set up your Hub (one computer, or Desk + Hub over Tailscale)`);
      hr();
      saveOnboarding({ hubNetworkAsked: true });
      const go = await choose("Set up your Hub now?", [
        { key: "now", label: "Set up now (a few minutes)" },
        { key: "later", label: "Later (it stays in this menu as \"Set up Hub network\")" },
      ]);
      if (go?.key === "now") await runHubNetworkSetup();
      continue;
    }

    hr();

    const hubHost = (base) => String(base || "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
    const sshHubUp = isHubUpQuick() && !isHubNetworkUnset();
    const hubMenu = [
      {
        key: "hub-network",
        label: net.deskPaired
          ? `Hub network (paired · ${hubHost(net.deskApiBase)})`
          : net.hubInstalled
            ? "Hub network (this computer is the Hub)"
            : "Set up Hub network (Tailscale)",
      },
      ...(sshHubUp
        ? [
            { key: "hub", label: "Hub status (iMac OpenClaw · tunnel · Docker)" },
            { key: "hub-infra", label: "Hub infra (Docker container table)" },
          ]
        : [{ key: "hub-implement", label: "Advanced: fleet ops over SSH" }]),
    ];

    if (!cockpitReadyMarked) {
      cockpitReadyMarked = true;
      bootMark("cockpit menu ready");
    }
    const pick = await choose("What next?", [
      { key: "launch", label: "Open desk" },
      { key: "select-project", label: "Switch to another project" },
      { key: "checkpoint-project", label: "Save project to Base (with chat sync)" },
      ...hubMenu,
      { key: "meet", label: "Start meeting / morning recap" },
      { key: "roster", label: "View agent roster (MBP + iMac · status)" },
      { key: "kanban", label: "Kanban (agents · tasks · seats)" },
      { key: "inbox", label: "Bot inbox (iMessage · agents | thread)" },
      { key: "pstack", label: "Pstack (dossier pane · program store)" },
      { key: "factory", label: "Factory (project bots · Hub · desk infra)" },
      { key: "export-roster", label: "Export agent roster to CSV" },
      { key: "import", label: "Browse cartridge cAavegotchis" },
      { key: "mint", label: "Mint another wallet gotchi — Free (sub-agent identity)" },
      { key: "mint-collateral", label: "Mint a base collateral cAavegotchi ($5 USDC)" },
      { key: "marketplace", label: "View Marketplace" },
      { key: "settings", label: "Settings (voice, read speed, mouse, replay, IPFS, GitHub)" },
      { key: "avatar", label: "Change orchestrator avatar" },
    ]);
    if (!pick) quitToTerminal();
    if (pick.key === "launch") {
      const heroId = ob.orchestratorHeroId ?? (await pickOrchestrator(heroes));
      pinAvatar(heroId);
      saveOnboarding({ complete: true, orchestratorHeroId: heroId, wallet, cartridgeId });
      clear();
      console.log(readWelcomeArt(10));
      const proj = currentProjectSlug();
      console.log(`\n  ✓ Orchestrator ready — ${heroId}`);
      if (proj) console.log(`  ✓ Project — ${proj} (local · Base)`);
      else console.log("  · No project selected — pick one from cockpit anytime.");
      console.log("  Opening the desk…");
      console.log("  Talk in natural language to spin up sub-agents.");
      console.log("  Start an empty prompt with ! to run a shell command yourself — its output lands in chat.\n");
      const saying = quirkyOpenclawSaying();
      console.log(`  Hi fren! I'm GotchiBot. ${saying}`);
      console.log("  Welcome — press Enter to open the prompter.\n");
      spawnSync("node", [`${ROOT}/scripts/tts.mjs`, "speak", `Hi fren! I'm GotchiBot. ${saying}`, "--persona", "gotchi"], {
        cwd: ROOT,
        stdio: "ignore",
      });
      await pause("Press Enter to open the prompter");
      // Cockpit pane: restore the parked chat and the avatar. Do not boot
      // OpenCode inside this pane.
      if (process.env.GOTCHIBOT_COCKPIT_PANE === "1") {
        runLayout("leave-cockpit", { background: true, target: "work.0" });
        process.exit(0);
      }
      // chat-pane.sh continues into opencode after the gate exits.
      // Standalone `gotchibot onboarding` must exec the chat pane itself.
      if (process.env.GOTCHIBOT_IN_CHAT_PANE === "1") return;
      rl.close();
      const chatPane = `${ROOT}/scripts/chat-pane.sh`;
      spawnSync(chatPane, [], { cwd: ROOT, stdio: "inherit", env: { ...process.env, GOTCHIBOT_SKIP_ONBOARDING: "1" } });
      process.exit(0);
    }

    if (pick.key === "select-project") {
      await selectProjectMenu();
      continue;
    }

    if (pick.key === "checkpoint-project") {
      title("Save project to Base");
      const proj = currentProjectSlug();
      if (!proj) {
        console.log("  No project selected — create/pick one first.");
        await pause();
        continue;
      }
      console.log(`  Current project  ${proj}`);
      console.log("  1) Snapshot the chat sync on your Hub");
      console.log("  2) One signed checkpoint onto the cartridge: gameState.projects + chatSync");
      console.log("  3) MetaMask checkpointSave on Base Sepolia (hash + URI pointer)");
      console.log("  Local dossier stays on disk. No Hub / infra token → project only.\n");
      const label = `project:${proj}`;
      // The chat path writes this pin right after the Hub snapshot and before its identity
      // checkpoint; if it did not move, nothing was checkpointed and the project saves alone.
      const pinPath = `${ROOT}/sessions/.chat-sync-checkpoint.json`;
      const pinBefore = existsSync(pinPath) ? statSync(pinPath).mtimeMs : 0;
      const chat = spawnSync(
        process.execPath,
        [`${ROOT}/scripts/chat-sync.mjs`, "checkpoint-prompt", "--onchain"],
        {
          cwd: ROOT,
          env: { ...process.env, GOTCHIBOT_CHAT_CHECKPOINT: "1", GOTCHIBOT_CHAT_CHECKPOINT_LABEL: label },
          stdio: "inherit",
        },
      );
      const snapshotted = existsSync(pinPath) && statSync(pinPath).mtimeMs > pinBefore;
      if (snapshotted) {
        if (chat.status !== 0) console.log("  ✗ Sepolia send failed — the local checkpoint is saved; retry: gotchibot chats onchain");
        await pause();
        continue;
      }
      console.log("\n  · Chat sync unavailable — saving the project without it.");
      const r = spawnSync(
        process.execPath,
        [`${ROOT}/scripts/identity.mjs`, "checkpoint"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, GOTCHIBOT_CHECKPOINT_LABEL: label },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const out = String(r.stdout || "").trim();
      const err = String(r.stderr || "").trim();
      if (r.status === 0) {
        console.log(out || "  ✓ checkpoint posted");
      } else {
        console.log(`  ✗ checkpoint failed: ${(err || out).slice(0, 400)}`);
        console.log("  Retry when Base Sepolia / Hub is healthy.");
      }
      await pause();
      continue;
    }

    if (pick.key === "meet") {
      const opened = await startMeetingMenu(heroes);
      if (opened) {
        if (process.env.GOTCHIBOT_IN_CHAT_PANE === "1") {
          openMeetRoomFromPane();
        }
        rl.close();
        const chatPane = `${ROOT}/scripts/chat-pane.sh`;
        spawnSync(chatPane, [], {
          cwd: ROOT,
          stdio: "inherit",
          env: { ...process.env, GOTCHIBOT_SKIP_ONBOARDING: "1", GOTCHIBOT_SKIP_COCKPIT: "1", GOTCHIBOT_MEET: "1" },
        });
        process.exit(0);
      }
      continue;
    }

    if (pick.key === "hub") {
      await viewHubStatus();
      continue;
    }

    if (pick.key === "hub-network") {
      await runHubNetworkSetup();
      continue;
    }

    if (pick.key === "hub-implement") {
      await implementGotchiHubNetwork();
      continue;
    }

    if (pick.key === "hub-infra") {
      await viewHubInfra();
      continue;
    }

    if (pick.key === "roster") {
      await viewAgentRoster();
      continue;
    }

    if (pick.key === "kanban") {
      await viewKanban();
      continue;
    }

    if (pick.key === "inbox") {
      await viewBotInbox();
      continue;
    }

    if (pick.key === "pstack") {
      // Open dossier window on work.2, then leave cockpit into the project desk
      // (iMessage-style left pane) — same handoff as "Return to project" when
      // inside chat-pane.sh.
      enterPstackDossierLayout();
      if (process.env.GOTCHIBOT_IN_CHAT_PANE === "1") return;
      await pause();
      continue;
    }

    if (pick.key === "factory") {
      enterFactoryLayout();
      if (process.env.GOTCHIBOT_IN_CHAT_PANE === "1") return;
      await pause();
      continue;
    }

    if (pick.key === "export-roster") {
      await exportAgentRosterCsv();
      continue;
    }

    if (pick.key === "settings") {
      await settingsMenu();
      continue;
    }

    if (pick.key === "import") {
      if (!cartridgeId) {
        title("Browse cartridge cAavegotchis");
        console.log("  No Base Sepolia cartridge yet — mint one first.");
        console.log(`  ${CONCIERGE_MINT_URL}`);
        await pause();
        continue;
      }
      await importOrChooseGotchi(wallet, cartridgeId);
      continue;
    }

    if (pick.key === "mint") {
      if (!cartridgeId) {
        title("Mint wallet gotchi");
        console.log("  No Base Sepolia cartridge yet — mint a sealed cart first.");
        console.log(`  ${CONCIERGE_MINT_URL}`);
        await pause();
        continue;
      }
      title("Mint wallet gotchi — Free");
      console.log("  Bind an Aavegotchi you already own as a sub-agent identity.");
      console.log("  Free (MetaMask bindOwned — no $5 collateral fee).\n");
      const heroId = await runWalletGotchiMint(wallet, cartridgeId);
      if (heroId) {
        console.log(`  ✓ ${heroId} ready as sub-agent identity`);
        await assignAsOrchestratorIfFirst(heroId, wallet, cartridgeId);
        await syncFleetQuiet();
      }
      await pause();
      continue;
    }

    if (pick.key === "mint-collateral") {
      if (!cartridgeId) {
        title("Mint base collateral cAavegotchi");
        console.log("  No Base Sepolia cartridge yet — mint a sealed cart first.");
        console.log(`  ${CONCIERGE_MINT_URL}`);
        await pause();
        continue;
      }
      title("Mint base collateral cAavegotchi — $5 USDC");
      console.log("  Mint a starter collateral gotchi onto the nest (MetaMask bindStarter).");
      console.log("  Sub-agent identity — pick DAI / LINK / … from the collateral list.\n");
      const heroId = await runCollateralGotchiMint(wallet, cartridgeId);
      if (heroId) {
        console.log(`  ✓ ${heroId} ready as sub-agent identity`);
        await assignAsOrchestratorIfFirst(heroId, wallet, cartridgeId);
        await syncFleetQuiet();
      }
      await pause();
      continue;
    }

    if (pick.key === "marketplace") {
      title("Marketplace");
      console.log("  Bot-template packs for cAavegotchi assignment (slot 15).\n");
      openMarketplace();
      continue;
    }

    if (pick.key === "avatar") {
      const heroId = await pickOrchestrator(heroes);
      await setOrchestratorHero(heroId, wallet, cartridgeId);
      console.log(`\n  ✓ orchestrator avatar → ${heroId}`);
      await pause();
    }
  }
}

function clearStaleSessionPin() {
  const pinPath = `${ROOT}/sessions/.pin`;
  try {
    const pin = readFileSync(pinPath, "utf8").trim();
    if (/^s\d/.test(pin)) unlinkSync(pinPath);
  } catch {}
}

async function ensureOrchestratorHero(heroes) {
  if (loadOnboarding().orchestratorHeroId || !heroes.length) return;
  title("Orchestrator avatar");
  console.log("  First gotchi on this desk becomes the orchestrator (orch pack · slot 15).\n");
  const heroId = await pickOrchestrator(heroes);
  const wallet = readWalletFile() || loadOnboarding()?.wallet;
  const cartridgeId = loadOnboarding()?.cartridgeId || loadMeta()?.cartridgeId;
  await setOrchestratorHero(heroId, wallet, cartridgeId);
  console.log(`\n  ✓ orchestrator set → ${heroId}`);
  await pause();
}

async function run() {
  try {
    clearStaleSessionPin();
    const wallet = await connectWalletMenu();
    const cartridgeId = await ensureCartridge(wallet);
    const heroes = cartridgeId
      ? await resolveHeroes(wallet, cartridgeId)
      : [];
    await ensureOrchestratorHero(heroes);
    await mainMenu(wallet, cartridgeId);
  } finally {
    rl.close();
  }
}

/** In-app cockpit (/cockpit) — skip wallet welcome when already connected. */
async function loadCartridgeHeroesQuiet(wallet, cartridgeId) {
  return fetchDeskHeroes(wallet, cartridgeId);
}

async function runCockpit() {
  try {
    clearStaleSessionPin();
    let wallet = readWalletFile();
    if (!wallet) {
      wallet = await connectWalletMenu();
    }
    const cartridgeId = await ensureCartridge(wallet);
    // Cockpit is settings/mint/roster — not first-time onboarding bind flow.
    // mainMenu loads the roster itself; only fetch here when an orch must be picked first.
    if (!loadOnboarding().orchestratorHeroId) {
      await ensureOrchestratorHero(await loadCartridgeHeroesQuiet(wallet, cartridgeId));
    }
    await mainMenu(wallet, cartridgeId);
  } finally {
    rl.close();
  }
}

/** /meet — interactive meeting menu (Resume/End or Start), then meet room via exit 4. */
async function runMeet() {
  try {
    clearStaleSessionPin();
    let wallet = readWalletFile();
    if (!wallet) {
      wallet = await connectWalletMenu();
    }
    // Skip Cartridge splash — jump straight to the meeting menu.
    let heroes = [];
    try {
      const cartridgeId = await ensureCartridge(wallet);
      heroes = (await loadCartridgeHeroesQuiet(wallet, cartridgeId)) || [];
      await ensureOrchestratorHero(heroes);
    } catch (e) {
      console.log(`  ⚠ roster load: ${e.message || e}`);
    }
    const opened = await startMeetingMenu(heroes);
    if (!opened) {
      // Back / quit → chat-pane falls through to OpenCode
      process.exit(0);
    }
    // Resume or newly started → meet gallery (same as cockpit exit 4)
    openMeetRoomFromPane();
  } finally {
    try {
      rl.close();
    } catch {}
  }
}

const meetOnly = process.argv.includes("--meet");
const cockpitOnly = process.argv.includes("--cockpit");
(meetOnly ? runMeet() : cockpitOnly ? runCockpit() : run()).catch((e) => {
  console.error(`\n  ✗ ${e.message}`);
  process.exit(1);
});
