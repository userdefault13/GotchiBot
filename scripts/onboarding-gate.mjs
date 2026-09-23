#!/usr/bin/env node
/**
 * Interactive welcome / sign-in gate for GotchiBot tmux (center pane).
 */
import readline from "node:readline/promises";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import {
  ROOT,
  loadBaseStarterCollaterals,
  readWelcomeArt,
  readWalletFile,
  saveWalletFile,
  loadOnboarding,
  saveOnboarding,
  commandExists,
  hasServiceKey,
  runAbraNode,
  fetchCartridgeHeroes,
  fetchWalletGotchis,
  fetchWalletGotchiById,
  ensureCartridgeForOwner,
  bindStarterHero,
  bindOwnedGotchi,
  mintSubAgentHero,
  selectOrchestratorHero,
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

const CONCIERGE_MINT_URL = "https://www.aarcadeghst.com/concierge/terminal";

function preferSepoliaNest() {
  return (
    process.env.GOTCHIBOT_CARTRIDGE_CHAIN !== "sim" &&
    process.env.GOTCHIBOT_CARTRIDGE_CHAIN !== "local" &&
    (process.env.GOTCHIBOT_CARTRIDGE_CHAIN === "sepolia" ||
      process.env.GOTCHIBOT_CARTRIDGE_CHAIN === "84532" ||
      process.env.GOTCHIBOT_PREFER_SEPOLIA === "1" ||
      process.env.GOTCHIBOT_PREFER_SEPOLIA !== "0")
  );
}

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

/** Current project slug (sessions/.pstack-dossier-current · synced to .project-current). */
function currentProjectSlug() {
  const r = spawnSync(process.execPath, [`${ROOT}/scripts/project-context.mjs`, "current"], {
    cwd: ROOT,
    encoding: "utf8",
  });
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

async function selectProjectMenu({ freshInstall = false } = {}) {
  title("Select project");
  console.log("  Projects are sealed rooms — bots, meetings, and notes stay inside.");
  console.log("  Cart mirror: signed checkpoint (local default; IPFS via Settings).\n");
  const current = currentProjectSlug();
  if (current) console.log(`  current  ${current}\n`);

  // Always list dossiers so a just-created project can be re-picked if the
  // pointer was cleared. Fresh nest only changes the nudge copy — not the list.
  const slugs = listProjectSlugs();
  if (freshInstall) {
    console.log("  Fresh nest — create a new project or pick an existing one.\n");
  }
  const options = [
    ...slugs.map((slug) => ({
      key: `proj:${slug}`,
      label: slug === current ? `${slug}  (current)` : slug,
    })),
    { key: "new", label: "Create new project…" },
    { key: "back", label: "Back to cockpit" },
  ];
  const pick = await choose("Which project?", options);
  if (!pick || pick.key === "back") return;

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
    await pause();
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

async function choose(prompt, options) {
  console.log("");
  options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  console.log(`    q) Quit`);
  for (;;) {
    const ans = (await rl.question(`\n  ${prompt} [1-${options.length}]: `)).trim().toLowerCase();
    if (ans === "q" || ans === "quit") quitToTerminal();
    const n = Number(ans);
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log("  invalid choice");
  }
}

async function apiOp(op, ...args) {
  // Base Sepolia nest desks: no cartridge-sim. Desk-local pin + Concierge for on-chain bind.
  if (preferSepoliaNest()) {
    if (op === "select-hero") {
      // Desk pin only — no SIM select-hero.
      return args[0];
    }
    if (op === "ensure" || op === "bind-owned" || op === "bind-starter" || op === "mint-sub") {
      const err = new Error(
        `SIM disabled on Sepolia nest — ${op} is on-chain at Concierge: ${CONCIERGE_MINT_URL}`,
      );
      err.code = "SEPOLIA_NO_SIM";
      err.concierge = CONCIERGE_MINT_URL;
      throw err;
    }
  }

  const cartId = () => {
    const meta = loadMeta() || {};
    return meta.cartridgeId;
  };
  // Prefer direct SIM calls when the pane already has install/operator auth —
  // abra Touch ID mid-menu feels like a hang after picking a gotchi.
  const { hasInstallToken, hasOperatorServiceKey } = await import("./infra-client.mjs");
  const direct = hasServiceKey() || hasInstallToken() || hasOperatorServiceKey();
  if (direct) {
    if (op === "ensure") return ensureCartridgeForOwner(args[0]);
    if (op === "bind-starter") return bindStarterHero(cartId(), args[0]);
    if (op === "bind-owned") return bindOwnedGotchi(cartId(), args[0], args[1] || null);
    if (op === "mint-sub") return mintSubAgentHero(cartId(), args[0]);
    if (op === "select-hero") {
      await selectOrchestratorHero(cartId(), args[0]);
      return args[0];
    }
  }
  console.log("  · abracadabra Touch ID may prompt…");
  const argv =
    op === "bind-owned"
      ? ["bind-owned", String(args[0])]
      : op === "select-hero"
        ? ["select-hero", String(args[0])]
        : op === "mint-sub" || op === "bind-starter"
          ? [op, String(args[0])]
          : op === "ensure"
            ? ["ensure", String(args[0])]
            : [op, ...args.map(String)];
  const r = runAbraNode("scripts/onboarding-api.mjs", argv);
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "API call failed").trim());
  }
  const out = (r.stdout || "").trim();
  if (op === "ensure") {
    saveMeta({ cartridgeId: out, owner: args[0] });
    saveOnboarding({ cartridgeId: out, wallet: args[0] });
    return out;
  }
  if (op === "select-hero") return args[0];
  return out || null;
}

function openConcierge(extraNote = "") {
  console.log(`\n  Opening Concierge for on-chain open/bind (MetaMask will prompt)…`);
  if (extraNote) console.log(`  ${extraNote}`);
  console.log(`  ${CONCIERGE_MINT_URL}\n`);
  try {
    spawn("open", [CONCIERGE_MINT_URL], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can open manually */
  }
}

/**
 * SIM-only parallel identity cart. Sepolia nest desks skip this entirely.
 */
async function ensureSimIdentityCart(wallet, { bar = null } = {}) {
  if (preferSepoliaNest()) {
    if (bar) {
      await bar.advance(100, "Sepolia nest — no SIM cart", { ms: 200 });
    }
    return null;
  }
  const tick = async (pct, label, ms) => {
    if (!bar) return;
    await bar.advance(pct, label, { ms });
  };

  await tick(12, "Reading desk meta…", 280);
  const meta = loadMeta() || {};
  await tick(28, "Checking identity cart…", 280);

  if (meta.legacySimCartridgeId) {
    await tick(55, "Using cached identity cart…", 360);
    await tick(82, `Cart ${meta.legacySimCartridgeId}`, 280);
    await tick(100, `Identity cart ready (${meta.legacySimCartridgeId})`, 240);
    return meta.legacySimCartridgeId;
  }
  if (String(meta.cartridgeId || "").startsWith("sim-")) {
    await tick(55, "Using sim cartridge…", 360);
    await tick(82, `Cart ${meta.cartridgeId}`, 280);
    await tick(100, `Identity cart ready (${meta.cartridgeId})`, 240);
    return meta.cartridgeId;
  }

  const sepoliaId = meta.cartridgeId || null;
  const sepoliaSource = meta.cartridgeSource || (preferSepoliaNest() ? "sepolia" : null);
  const abraId = meta.abraCartridgeId || null;
  const abraVerified = meta.abraVerified;

  let simId;
  const { hasInstallToken, hasOperatorServiceKey } = await import("./infra-client.mjs");
  const direct = hasServiceKey() || hasInstallToken() || hasOperatorServiceKey();
  await tick(35, direct ? "Ensuring sim cart (direct)…" : "Ensuring sim cart (abra)…", 240);

  const ensureFn = async () => {
    if (direct) {
      return ensureCartridgeForOwner(wallet);
    }
    return new Promise((resolve, reject) => {
      if (!commandExists("abra")) {
        reject(new Error("abra not found — run: abra run gotchibot -- ./scripts/gotchibot tmux"));
        return;
      }
      const child = spawn(
        "abra",
        ["run", "gotchibot", "--", process.execPath, `${ROOT}/scripts/onboarding-api.mjs`, "ensure", wallet],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error((err || out || "ensure sim cart failed").trim()));
          return;
        }
        resolve((out || "").trim());
      });
    });
  };

  if (bar) {
    simId = await bar.pulse(
      direct ? "Contacting cartridge-sim…" : "abra Touch ID / ensure…",
      ensureFn,
      { nextPct: 78, minMs: 900 },
    );
  } else {
    simId = await ensureFn();
  }
  if (!simId) throw new Error("ensure sim cart returned empty id");

  await tick(90, "Saving identity meta…", 280);
  saveMeta({
    owner: wallet,
    cartridgeId: sepoliaId,
    cartridgeSource: sepoliaSource,
    legacySimCartridgeId: simId,
    abraCartridgeId: abraId,
    abraVerified,
  });
  if (sepoliaId) saveOnboarding({ wallet, cartridgeId: sepoliaId });
  await tick(100, `Identity cart ready (${simId})`, 240);
  return simId;
}

async function setOrchestratorHero(heroId, wallet, cartridgeId, { skipSelectApi = false } = {}) {
  const skipSelect = skipSelectApi || preferSepoliaNest();
  if (!skipSelect) {
    try {
      await apiOp("select-hero", heroId);
    } catch (e) {
      console.log(`  · select-hero skipped: ${e?.message || e}`);
    }
  }
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

/** First orch for a fresh nest desk — before project select. */
async function runFirstOrchMintMenu(wallet, cartridgeId) {
  title("Mint orchestrator");
  console.log("  First gotchi minted becomes the orchestrator (orch pack · slot 15).");
  if (preferSepoliaNest()) {
    console.log("  Base Sepolia nest — no cartridge-sim. Desk pin here; MetaMask bind at Concierge.\n");
  } else {
    console.log("  Pick how to mint it:\n");
  }

  if (preferSepoliaNest()) {
    try {
      const sep = await readGotchiBotCartridgeSepolia(wallet);
      if (sep.portalStatus === 1 && sep.cartridgeId) {
        console.log("  note: sealed cart — open on-chain before bind.\n");
        const openPick = await choose("Open sealed cart first?", [
          { key: "open", label: "YES — MetaMask open(cartridgeId) now" },
          { key: "later", label: "Skip — open later / Concierge" },
        ]);
        if (openPick?.key === "open") {
          const { promptAndOpenSealedCart } = await import("./cartridge-mint-sepolia.mjs");
          const opened = await promptAndOpenSealedCart(wallet, sep.cartridgeId, { autoYes: true });
          if (opened?.ok) {
            console.log("  ✓ Cart open — pick a gotchi to bind as orch.\n");
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const pickOpts = preferSepoliaNest()
    ? [
        { key: "wallet", label: "Pick wallet Aavegotchi → desk orch + Concierge bind (MetaMask)" },
        { key: "open", label: "Open sealed cart (MetaMask · GotchiBotNestFacet.open)" },
        { key: "concierge", label: "Open Concierge only (bind / mint on-chain)" },
        { key: "back", label: "Back / quit" },
      ]
    : [
        { key: "wallet", label: "Import wallet Aavegotchi (free · bind owned)" },
        { key: "collateral", label: "Mint collateral cAavegotchi — $5" },
        { key: "back", label: "Back / quit" },
      ];

  const pick = await choose("How to mint your orchestrator?", pickOpts);
  if (!pick || pick.key === "back") return null;

  if (pick.key === "open") {
    try {
      const sep = await readGotchiBotCartridgeSepolia(wallet);
      if (!sep.cartridgeId) {
        console.log("  · No GotchiBot cart yet — mint one first.");
        await pause();
        return null;
      }
      if (sep.portalStatus === 2) {
        console.log(`  · Cart #${sep.cartridgeId} already open.`);
        await pause();
        return null;
      }
      const { promptAndOpenSealedCart } = await import("./cartridge-mint-sepolia.mjs");
      await promptAndOpenSealedCart(wallet, sep.cartridgeId, { autoYes: true });
    } catch (e) {
      console.log(`  ✗ ${e?.message || e}`);
    }
    await pause();
    return null;
  }

  if (pick.key === "concierge") {
    openConcierge("Open sealed cart, then bind owned/starter — MetaMask will prompt.");
    await pause("Press Enter after you finish in Concierge…");
    const nest = await fetchDeskHeroes(wallet, cartridgeId);
    if (nest.length) {
      const heroId = String(nest[0].id);
      await setOrchestratorHero(heroId, wallet, cartridgeId);
      console.log(`  ✓ first nest hero → orchestrator ${heroId}`);
      return heroId;
    }
    console.log("  · No nest heroes yet — bind one in Concierge, then return to cockpit.");
    await pause();
    return null;
  }

  if (!preferSepoliaNest()) {
    try {
      console.log("");
      const bar = new Progress();
      bar.set(0, "Preparing identity cartridge…");
      try {
        await ensureSimIdentityCart(wallet, { bar });
        bar.done("Identity cartridge ready");
      } catch (inner) {
        bar.fail("Identity cartridge — failed");
        throw inner;
      }
    } catch (e) {
      console.log(`  · ensure sim cart: ${e?.message || e}`);
      console.log("  · continuing — will set desk orch locally if SIM is down");
    }
  }

  if (pick.key === "wallet") {
    let onChain = [];
    try {
      onChain = await withStatusBar("Loading gotchis from subgraph…", () => fetchWalletGotchis(wallet));
    } catch (e) {
      console.log(`  Subgraph: ${e.message || e}`);
    }
    if (!onChain.length) {
      console.log("\n  No Aavegotchis in this wallet.");
      console.log(
        preferSepoliaNest()
          ? "  Buy/mint one on Base, or mint/bind at Concierge."
          : "  Buy/mint one on Base, or pick collateral cAavegotchi ($5).",
      );
      await pause();
      return null;
    }
    const options = onChain.slice(0, 40).map((g) => ({
      key: String(g.gotchiId ?? g.id),
      label: formatGotchiLabel(g),
      gotchi: g,
    }));
    const gPick = await choose(
      preferSepoliaNest() ? "Which wallet gotchi becomes orch?" : "Which wallet gotchi? (free bind)",
      options,
    );
    if (!gPick) return null;
    const tokenId = String(gPick.key);
    const heroId = `owned-${tokenId}`;

    // Persist collateral art for desk avatar even before nest bind.
    try {
      const { persistHeroCollateral, findCollateralColors } = await import("./collateral-resolve.mjs");
      const { libraryNameToSpiritId } = await import("./onboarding-lib.mjs");
      const g = gPick.gotchi || {};
      const hauntId = g.hauntId != null ? Number(g.hauntId) : null;
      const colors = findCollateralColors(g.collateral || g.collateralName || "", hauntId || 2);
      const spirit =
        colors?.spirit || libraryNameToSpiritId(g.collateralName || g.collateral || "") || null;
      persistHeroCollateral(heroId, {
        collateral: spirit,
        collateralAddress: g.collateral || null,
        collateralName: colors?.name || g.collateralName || null,
        hauntId,
        primary: colors?.primary,
        secondary: colors?.secondary,
        sourceTokenId: tokenId,
      });
    } catch {}

    if (preferSepoliaNest()) {
      console.log(`\n  Desk orch → ${heroId} (slot 15 orch pack).`);
      console.log("  Nest bind is on-chain — MetaMask sign at Concierge.\n");
      await setOrchestratorHero(heroId, wallet, cartridgeId);
      openConcierge(`Bind owned #${tokenId} into cart #${cartridgeId} (open first if sealed).`);
      await pause("Press Enter after MetaMask bind in Concierge (or skip for desk-only)…");
      console.log(`  ✓ orchestrator → ${heroId}`);
      return heroId;
    }

    console.log(`\n  Binding owned gotchi #${tokenId} (free)…`);
    try {
      const bar = new Progress();
      bar.set(10, `Binding owned #${tokenId}…`);
      let bound;
      try {
        bound = await bar.pulse(`Binding owned #${tokenId}…`, () => apiOp("bind-owned", tokenId, gPick.gotchi), {
          nextPct: 70,
        });
      } catch (bindErr) {
        bar.fail(`Bind #${tokenId} — failed`);
        throw bindErr;
      }
      const id = bound || heroId;
      bar.set(85, `Setting orchestrator ${id}…`);
      await setOrchestratorHero(id, wallet, cartridgeId);
      bar.done(`orchestrator → ${id}`);
      console.log(`  ✓ bound ${id}`);
      console.log(`  ✓ orchestrator → ${id}`);
      await pause();
      return id;
    } catch (e) {
      console.log(`  ✗ bind failed: ${String(e?.message || e).slice(0, 200)}`);
      await pause();
      return null;
    }
  }

  // collateral $5 — SIM desks only
  if (preferSepoliaNest()) {
    console.log("  Collateral mint-sub is SIM-only — use wallet gotchi or Concierge on Sepolia.");
    openConcierge();
    await pause();
    return null;
  }
  const collateral = await pickCollateral("Choose collateral for orchestrator cAavegotchi");
  console.log(`\n  Minting orchestrator (${collateral}) · $5…`);
  try {
    const heroId = await apiOp("mint-sub", collateral);
    console.log(`  ✓ minted ${heroId}`);
    await setOrchestratorHero(heroId, wallet, cartridgeId);
    console.log(`  ✓ orchestrator → ${heroId}`);
    await pause();
    return heroId;
  } catch (e) {
    console.log(`  ✗ mint failed: ${String(e?.message || e).slice(0, 200)}`);
    console.log("  Try wallet gotchi (free) or retry later.");
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

  if (preferSepoliaNest()) {
    try {
      const sep = await readGotchiBotCartridgeSepolia(wallet);
      const meta = loadMeta() || {};
      const prevId = meta.cartridgeId ? String(meta.cartridgeId) : "";
      const patch = {
        owner: wallet,
        cartridgeSource: "sepolia",
        cartridgeId: sep.cartridgeId || null,
      };
      if (prevId.startsWith("sim-")) {
        patch.legacySimCartridgeId = prevId;
      }
      saveMeta(patch);

      if (!sep.cartridgeId || sep.heroCount === 0) {
        // Fresh Sepolia nest — drop sim-era orch pin so cockpit shows unset.
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
        console.log(
          `  ✓ Base Sepolia cartridge ${sep.cartridgeId} · ${sep.heroCount} cAavegotchi(s)`,
        );
        return sep.cartridgeId;
      }
      console.log("  · Base Sepolia: no cartridge yet (sim mints do not count)");
      console.log(`  · Mint nested sealed cart: ${CONCIERGE_MINT_URL}`);
      return null;
    } catch (e) {
      console.log(`  · Sepolia read failed: ${e?.message || e}`);
      console.log(`  · Mint at Concierge: ${CONCIERGE_MINT_URL}`);
      return null;
    }
  }

  let meta = loadMeta();
  if (meta?.cartridgeId) {
    console.log(`  ✓ cartridge ${meta.cartridgeId}`);
    return meta.cartridgeId;
  }
  console.log("  No cartridge on file — sim-minting one now (no on-chain tx)…");
  if (!hasServiceKey() && !commandExists("abra")) {
    throw new Error("abra required: abra run gotchibot -- ./scripts/gotchibot tmux");
  }
  const id = await apiOp("ensure", wallet);
  console.log(`  ✓ cartridge ${id}`);
  return id;
}

async function fetchDeskHeroes(wallet, cartridgeId) {
  if (!cartridgeId) return [];
  if (preferSepoliaNest() && !String(cartridgeId).startsWith("sim-")) {
    try {
      const sep = await readGotchiBotCartridgeSepolia(wallet);
      if (sep.cartridgeId && String(sep.cartridgeId) === String(cartridgeId)) {
        return (sep.heroes || []).map((id) => ({ id: String(id) }));
      }
      return [];
    } catch {
      return [];
    }
  }
  return fetchCartridgeHeroes(cartridgeId);
}

async function identityCartHeroIds() {
  if (preferSepoliaNest()) return [];
  const meta = loadMeta() || {};
  const simId =
    meta.legacySimCartridgeId ||
    (String(meta.cartridgeId || "").startsWith("sim-") ? meta.cartridgeId : null);
  if (!simId) return [];
  try {
    const heroes = await fetchCartridgeHeroes(simId);
    return (heroes || []).map((h) => String(h.id || h)).filter(Boolean);
  } catch {
    return [];
  }
}

/** Sepolia nest desk: orch from nest heroes or desk-local pin — never SIM. */
async function resolveValidOrchestratorId(wallet, cartridgeId) {
  const ob = loadOnboarding();
  const meta = loadMeta() || {};
  const raw = ob.orchestratorHeroId || null;
  if (!preferSepoliaNest() || !cartridgeId) return raw;
  if (!raw) return null;

  const nest = await fetchDeskHeroes(wallet, cartridgeId);
  const nestIds = new Set((nest || []).map((h) => String(h.id)));
  if (nestIds.has(String(raw))) return raw;

  // Desk-local orch (assigned before Concierge nest bind) — keep pin.
  if (meta.activeHeroId && String(meta.activeHeroId) === String(raw)) return raw;
  if (String(raw).startsWith("owned-") || String(raw).startsWith("starter-")) return raw;

  console.log(`  · clearing stale orch pin ${raw} (not on this nest desk)`);
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

/** Confirm import of an owned on-chain gotchi (SIM mint is free). */
async function confirmOwnedImport(g) {
  clear();
  title("Owned Aavegotchi");
  console.log(`  Selected  ${formatGotchiLabel(g)}`);
  console.log("  This wallet already owns this gotchi on Base.");
  console.log("  Binding it as a cAavegotchi is free (no SIM fee).\n");
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
  console.log(`  to mint / bind   ${pending.length}  (free — no SIM fee)\n`);
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
  const bar = new Progress();
  const total = pending.length;
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
    if (n >= 1 && n <= options.length) return options[n - 1].id;
    console.log(`  pick 1–${options.length}`);
  }
}

async function mintNewGotchi({ collateralPrompt, apiOpName = "bind-starter", intro } = {}) {
  title("Mint cAavegotchi");
  console.log(intro ?? "  Mint a cAavegotchi for $5.");
  console.log("  (Simulated mint — no on-chain tx in this build.)\n");
  const collateral = await pickCollateral(collateralPrompt);
  console.log(`\n  Minting (${collateral})…`);
  const heroId = await apiOp(apiOpName, collateral);
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
    onChain = await withStatusBar("Loading gotchis from subgraph…", () => fetchWalletGotchis(wallet));
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

async function settingsMenu() {
  for (;;) {
    const tts = loadTtsSettings();
    const tui = loadTuiPrefs();
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
      { key: "back", label: "Back to cockpit" },
    ]);
    if (!pick || pick.key === "back") return;

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
    onChain = await withStatusBar("Loading on-chain gotchis…", () => fetchWalletGotchis(wallet));
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
        console.log("  · Still sealed — open before bind (cockpit → mint orch → Open sealed cart)");
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

async function mainMenu(wallet, cartridgeId) {
  for (;;) {
    clear();
    console.log(readWelcomeArt(12));
    const heroes = await fetchDeskHeroes(wallet, cartridgeId);
    const orchId = await resolveValidOrchestratorId(wallet, cartridgeId);
    const ob = { ...loadOnboarding(), orchestratorHeroId: orchId };
    const orch = orchId ?? "(none)";
    let abraSnap = null;
    let abraLine = "(skipped)";
    if (preferSepoliaNest()) {
      try {
        abraSnap = await readAbraCartridgeSepolia(wallet);
        abraLine = formatAbraCartLine(abraSnap);
      } catch (e) {
        abraLine = `(read failed: ${e?.message || e})`;
      }
    }

    // Sepolia desk needs a GotchiBot cart before the full cockpit — open mint UI.
    // (Abra may already be minted; mint menu still offers Abra / Bundle / GBOT.)
    const needsGotchiBotCart = preferSepoliaNest() && !cartridgeId;

    const project = currentProjectSlug();
    title("GotchiBot cockpit");
    console.log(`  wallet      ${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    console.log(
      `  cartridge   ${
        cartridgeId
          ? `${cartridgeId}${preferSepoliaNest() && !String(cartridgeId).startsWith("sim-") ? " (Base Sepolia)" : ""}`
          : "(none — mint on Base Sepolia)"
      }`,
    );
    console.log(`  abra cart   ${abraLine}`);
    console.log(`  roster      ${heroes.length} cAavegotchi(s)`);
    console.log(`  orchestrator ${orch}`);
    console.log(`  project     ${project || "(none — select a project)"}`);
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

    // Cart ready → mint orchestrator before project.
    if (preferSepoliaNest() && cartridgeId && !orchId) {
      console.log(`  next        mint orchestrator (wallet free · or collateral $5)`);
      hr();
      const heroId = await runFirstOrchMintMenu(wallet, cartridgeId);
      if (!heroId) quitToTerminal();
      continue;
    }

    // New nest desk: need a current project before the full cockpit.
    if (preferSepoliaNest() && cartridgeId && orchId && !project) {
      console.log(`  next        select or create a project`);
      hr();
      await selectProjectMenu({ freshInstall: true });
      if (!currentProjectSlug()) {
        console.log("  · no project selected yet — pick or create one to continue");
        await pause();
      }
      continue;
    }
    hr();

    const pick = await choose("What next?", [
      { key: "launch", label: project ? `Return to project (${project})` : "Return to project" },
      { key: "select-project", label: "Select new project" },
      { key: "checkpoint-project", label: "Checkpoint project → cart (signed gameState)" },
      { key: "meet", label: "Start meeting / morning recap" },
      { key: "hub", label: "Hub status (iMac OpenClaw · tunnel · Docker)" },
      { key: "hub-infra", label: "Hub infra (Docker container table)" },
      { key: "roster", label: "View agent roster (MBP + iMac · status)" },
      { key: "kanban", label: "Kanban (agents · tasks · seats)" },
      { key: "inbox", label: "Bot inbox (internal mail · FYI / reports)" },
      { key: "pstack", label: "Pstack (dossier pane · program store)" },
      { key: "export-roster", label: "Export agent roster to CSV" },
      { key: "settings", label: "Settings (voice, read speed, mouse, replay, IPFS)" },
      { key: "import", label: "Import on-chain gotchi / browse cartridge cAavegotchis" },
      { key: "mint-cart", label: "Mint sealed cart (Abra / GotchiBot / Bundle · Base Sepolia)" },
      { key: "mint", label: "Mint another cAavegotchi — $5 (sub-agent identity)" },
      { key: "avatar", label: "Change orchestrator avatar" },
    ]);
    if (!pick) quitToTerminal();
    if (pick.key === "launch") {
      const heroId = ob.orchestratorHeroId ?? (await pickOrchestrator(heroes));
      await apiOp("select-hero", heroId);
      pinAvatar(heroId);
      saveOnboarding({ complete: true, orchestratorHeroId: heroId, wallet, cartridgeId });
      clear();
      console.log(readWelcomeArt(10));
      const proj = currentProjectSlug();
      console.log(`\n  ✓ Orchestrator ready — ${heroId}`);
      if (proj) console.log(`  ✓ Project — ${proj}`);
      else console.log("  · No project selected — pick one from cockpit anytime.");
      console.log("  Returning to the project desk…");
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
      title("Checkpoint project → cart");
      const proj = currentProjectSlug();
      if (!proj) {
        console.log("  No project selected — create/pick one first.");
        await pause();
        continue;
      }
      console.log(`  Current project  ${proj}`);
      console.log("  Writes gameState.projects onto the cartridge via signed checkpoint.");
      console.log("  (SIM/Hub must be up; not a separate mint.)\n");
      const label = `project:${proj}`;
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
        console.log("  Retry when cartridge-sim / Hub is healthy.");
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
        title("Import gotchi");
        console.log("  No Base Sepolia cartridge yet — mint one first.");
        console.log(`  ${CONCIERGE_MINT_URL}`);
        await pause();
        continue;
      }
      await importOrChooseGotchi(wallet, cartridgeId);
      continue;
    }

    if (pick.key === "mint-cart") {
      const nextId = await runSealedCartMintMenu(wallet, { abraSnap });
      if (nextId) cartridgeId = nextId;
      continue;
    }

    if (pick.key === "mint") {
      if (!cartridgeId) {
        title("Mint cAavegotchi");
        console.log("  No Base Sepolia cartridge yet — mint a sealed cart first.");
        console.log(`  ${CONCIERGE_MINT_URL}`);
        await pause();
        continue;
      }
      if (preferSepoliaNest()) {
        title("Mint / bind cAavegotchi (on-chain)");
        console.log("  SIM mint-sub is off on Sepolia nest.");
        console.log("  Open Concierge — MetaMask will prompt to open/bind/mint.\n");
        openConcierge();
        await pause("Press Enter after Concierge…");
        continue;
      }
      const firstOrch = !loadOnboarding()?.orchestratorHeroId;
      title(firstOrch ? "Mint orchestrator (first gotchi)" : "Mint cAavegotchi");
      console.log(
        firstOrch
          ? "  First gotchi minted becomes the orchestrator (orch pack · slot 15).\n"
          : "  Mint a new sub-agent cAavegotchi for $5.\n",
      );
      const collateral = await pickCollateral(
        firstOrch ? "Choose collateral for orchestrator cAavegotchi" : "Choose collateral for new sub-agent hero",
      );
      console.log(`\n  Minting ${firstOrch ? "orchestrator" : "sub-agent"} (${collateral})${firstOrch ? "" : "…"}`);
      const heroId = await apiOp("mint-sub", collateral);
      if (firstOrch) {
        await setOrchestratorHero(heroId, wallet, cartridgeId);
        console.log(`  ✓ minted ${heroId} → orchestrator`);
      } else {
        console.log(`  ✓ minted ${heroId} (available for sub-agent spawn)`);
        await syncFleetQuiet();
      }
      await pause();
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
    const heroes = await loadCartridgeHeroesQuiet(wallet, cartridgeId);
    await ensureOrchestratorHero(heroes);
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
