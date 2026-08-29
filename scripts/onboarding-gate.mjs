#!/usr/bin/env node
/**
 * Interactive welcome / sign-in gate for GotchiBot tmux (center pane).
 */
import readline from "node:readline/promises";
import { readFileSync, unlinkSync } from "node:fs";
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
  if (hasServiceKey()) {
    const handlers = {
      ensure: () => ensureCartridgeForOwner(args[0]),
      "bind-starter": () => bindStarterHero(loadMeta()?.cartridgeId, args[0]),
      "bind-owned": () => bindOwnedGotchi(loadMeta()?.cartridgeId, args[0]),
      "mint-sub": () => mintSubAgentHero(loadMeta()?.cartridgeId, args[0]),
      "select-hero": () => selectOrchestratorHero(loadMeta()?.cartridgeId, args[0]),
    };
    return handlers[op]();
  }
  const r = runAbraNode("scripts/onboarding-api.mjs", [op, ...args.map(String)]);
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

/** Pick existing cAavegotchi on cartridge and/or import an on-chain gotchi. */
async function pickHeroOrImportGotchi(wallet, cartridgeId, allGotchis, cartridgeHeroes = []) {
  let view = allGotchis.length > 0 ? "onchain" : "cartridge";
  let cartridge = Array.isArray(cartridgeHeroes) ? [...cartridgeHeroes] : [];
  let page = 0;
  let searchMode = false;
  let searchList = null;

  const activeList = () => {
    if (searchMode && searchList) return searchList;
    return view === "cartridge" ? cartridge : allGotchis;
  };

  for (;;) {
    const items = activeList();
    const totalPages = Math.max(1, Math.ceil(items.length / GOTCHI_PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;
    const start = page * GOTCHI_PAGE_SIZE;
    const slice = items.slice(start, start + GOTCHI_PAGE_SIZE);

    clear();
    title(view === "cartridge" ? "Cartridge cAavegotchis" : "On-chain gotchis");
    if (searchMode) {
      console.log(`  Search results — ${items.length} match(es)\n`);
    } else {
      const headline =
        view === "cartridge"
          ? `${cartridge.length} cAavegotchi(s) minted on this cartridge`
          : `${allGotchis.length} gotchi(s) in wallet`;
      console.log(`  ${headline}${totalPages > 1 ? ` · page ${page + 1}/${totalPages}` : ""}\n`);
      if (totalPages > 1) renderGotchiPageTabs(page, totalPages);
      console.log("");
    }

    if (!slice.length) {
      console.log(
        view === "cartridge"
          ? "  (none yet — mint one or switch to on-chain import)"
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
    if (!searchMode && totalPages > 1) {
      if (page > 0) console.log("    [p] Previous page");
      if (page < totalPages - 1) console.log("    [n] Next page");
      console.log("    [tN] Jump to page tab (e.g. t2)");
    }
    if (!searchMode) {
      if (view === "onchain") {
        console.log(`    [c] Switch to cartridge cAavegotchis (${cartridge.length})`);
      } else {
        console.log(`    [o] Switch to on-chain wallet (${allGotchis.length})`);
      }
    }
    console.log("    [s] Search by gotchi ID or cAavegotchi id");
    console.log("    [m] Mint new cAavegotchi ($5)");
    if (searchMode) console.log("    [b] Back to full list");
    console.log("    [q] Quit");

    const ans = (await rl.question("\n  Pick [number / c / o / m / n / p / s / q]: ")).trim().toLowerCase();

    if (ans === "q" || ans === "quit") quitToTerminal();

    if (ans === "m" || ans === "mint") {
      const heroId = await mintNewGotchi({
        collateralPrompt: "Choose collateral for new cAavegotchi",
        intro: "  Mint a new cAavegotchi for $5.",
      });
      return { kind: "mint", heroId };
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

    if (ans === "n" && !searchMode && page < totalPages - 1) {
      page++;
      continue;
    }

    if (ans === "p" && !searchMode && page > 0) {
      page--;
      continue;
    }

    const tabMatch = /^t(\d+)$/.exec(ans);
    if (!searchMode && tabMatch && totalPages > 1) {
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
          allGotchis.find((g) => String(g.gotchiId) === id) ??
          (await fetchWalletGotchiById(wallet, id));
        if (!found) {
          console.log(`  #${id} not found in wallet or cartridge`);
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
  console.log("  Loading gotchis from subgraph…");
  let onChain = [];
  try {
    onChain = await fetchWalletGotchis(wallet);
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
    console.log(`\n  Binding owned gotchi #${pick.gotchi.gotchiId} (free)…`);
    const heroId = await apiOp("bind-owned", pick.gotchi.gotchiId);
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
  console.log("\n  Loading on-chain gotchis…");
  let onChain = [];
  try {
    onChain = await fetchWalletGotchis(wallet);
  } catch (e) {
    console.log(`  ${e.message || e}`);
  }
  const cartridgeHeroes = (await fetchCartridgeHeroes(cartridgeId)) || [];
  const pick = await pickHeroOrImportGotchi(wallet, cartridgeId, onChain, cartridgeHeroes);
  if (!pick) return;
  if (pick.kind === "cartridge") {
    console.log(`\n  ✓ selected cAavegotchi ${pick.hero.id}`);
  } else if (pick.kind === "mint") {
    console.log(`\n  ✓ minted ${pick.heroId}`);
    await syncFleetQuiet();
  } else {
    console.log(`\n  Binding owned gotchi #${pick.gotchi.gotchiId} (free)…`);
    const heroId = await apiOp("bind-owned", pick.gotchi.gotchiId);
    console.log(`  ✓ bound ${heroId}`);
    await syncFleetQuiet();
  }
  await pause();
}

async function mainMenu(wallet, cartridgeId) {
  for (;;) {
    clear();
    console.log(readWelcomeArt(12));
    const heroes = await fetchCartridgeHeroes(cartridgeId);
    const ob = loadOnboarding();
    const orch = ob.orchestratorHeroId ?? "(none)";

    title("GotchiBot cockpit");
    console.log(`  wallet      ${wallet.slice(0, 6)}…${wallet.slice(-4)}`);
    console.log(`  cartridge   ${cartridgeId}`);
    console.log(`  roster      ${heroes.length} cAavegotchi(s)`);
    console.log(`  orchestrator ${orch}`);
    hr();

    const pick = await choose("What next?", [
      { key: "launch", label: "Return to chat (orchestrator)" },
      { key: "roster", label: "View agent roster (MBP + iMac · status)" },
      { key: "export-roster", label: "Export agent roster to CSV" },
      { key: "import", label: "Import on-chain gotchi / browse cartridge cAavegotchis" },
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
      console.log(`\n  ✓ Orchestrator ready — ${heroId}`);
      console.log("  Launching OpenCode gotchi mode…");
      console.log("  Talk in natural language to spin up sub-agents.\n");
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

    if (pick.key === "roster") {
      await viewAgentRoster();
      continue;
    }

    if (pick.key === "export-roster") {
      await exportAgentRosterCsv();
      continue;
    }

    if (pick.key === "import") {
      await importOrChooseGotchi(wallet, cartridgeId);
      continue;
    }

    if (pick.key === "mint") {
      title("Mint cAavegotchi");
      console.log("  Mint a new sub-agent cAavegotchi for $5.\n");
      const collateral = await pickCollateral("Choose collateral for new sub-agent hero");
      console.log(`\n  Minting sub-agent (${collateral})…`);
      const heroId = await apiOp("mint-sub", collateral);
      console.log(`  ✓ minted ${heroId} (available for sub-agent spawn)`);
      await syncFleetQuiet();
      await pause();
      continue;
    }

    if (pick.key === "avatar") {
      const heroId = await pickOrchestrator(heroes);
      await apiOp("select-hero", heroId);
      pinAvatar(heroId);
      saveOnboarding({ orchestratorHeroId: heroId });
      console.log(`\n  ✓ orchestrator avatar → ${heroId}`);
      await syncFleetQuiet();
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
  const heroId = await pickOrchestrator(heroes);
  await apiOp("select-hero", heroId);
  pinAvatar(heroId);
  saveOnboarding({ orchestratorHeroId: heroId });
  console.log(`\n  ✓ orchestrator set → ${heroId}`);
  await pause();
}

async function run() {
  try {
    clearStaleSessionPin();
    const wallet = await connectWalletMenu();
    const cartridgeId = await ensureCartridge(wallet);
    const heroes = await resolveHeroes(wallet, cartridgeId);
    await ensureOrchestratorHero(heroes);
    await mainMenu(wallet, cartridgeId);
  } finally {
    rl.close();
  }
}

/** In-app cockpit (/cockpit) — skip wallet welcome when already connected. */
async function loadCartridgeHeroesQuiet(cartridgeId) {
  let heroes = await fetchCartridgeHeroes(cartridgeId);
  if (!heroes.length) {
    heroes = await fetchCartridgeHeroes(cartridgeId);
  }
  return heroes;
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
    const heroes = await loadCartridgeHeroesQuiet(cartridgeId);
    await ensureOrchestratorHero(heroes);
    await mainMenu(wallet, cartridgeId);
  } finally {
    rl.close();
  }
}

const cockpitOnly = process.argv.includes("--cockpit");
(cockpitOnly ? runCockpit() : run()).catch((e) => {
  console.error(`\n  ✗ ${e.message}`);
  process.exit(1);
});
