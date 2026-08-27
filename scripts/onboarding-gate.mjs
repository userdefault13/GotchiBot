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
  COLLATERALS_16,
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

async function choose(prompt, options) {
  console.log("");
  options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  console.log(`    q) Quit`);
  for (;;) {
    const ans = (await rl.question(`\n  ${prompt} [1-${options.length}]: `)).trim().toLowerCase();
    if (ans === "q" || ans === "quit") return null;
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
  console.log("\n  Opening browser for MetaMask…");
  console.log("  Sign the message in MetaMask, then return here.\n");

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
  opts.push({ key: "mm", label: "MetaMask — browser sign-in" });
  if (commandExists("abra")) {
    opts.push({ key: "abra", label: "Abracadabra — fetch wallet from vault (Touch ID)" });
  }

  const pick = await choose("Connect wallet", opts);
  if (!pick) process.exit(0);

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
  const name = g.name || `#${g.gotchiId}`;
  return `#${g.gotchiId}  ${name}`;
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

/** Paginated on-chain gotchi picker — 25 per page, tab jump, search by id. */
async function pickOnChainGotchi(wallet, allGotchis) {
  let page = 0;
  let list = allGotchis;
  let searchMode = false;

  for (;;) {
    const totalPages = Math.max(1, Math.ceil(list.length / GOTCHI_PAGE_SIZE));
    if (page >= totalPages) page = totalPages - 1;
    const start = page * GOTCHI_PAGE_SIZE;
    const slice = list.slice(start, start + GOTCHI_PAGE_SIZE);

    clear();
    title("Import on-chain gotchi");
    if (searchMode) {
      console.log(`  Search results — ${list.length} match(es)\n`);
    } else {
      console.log(`  ${allGotchis.length} gotchi(s) in wallet — showing ${start + 1}–${start + slice.length}\n`);
      if (totalPages > 1) renderGotchiPageTabs(page, totalPages);
    }

    slice.forEach((g, i) => {
      console.log(`    ${String(i + 1).padStart(2)} ) ${formatGotchiLabel(g)}`);
    });

    console.log("");
    if (!searchMode && totalPages > 1) {
      if (page > 0) console.log("    [p] Previous page");
      if (page < totalPages - 1) console.log("    [n] Next page");
      console.log("    [tN] Jump to page tab (e.g. t2)");
    }
    console.log("    [s] Search by gotchi ID");
    if (searchMode) console.log("    [b] Back to full list");
    console.log("    [q] Quit");

    const ans = (await rl.question("\n  Import [number / n / p / s / q]: ")).trim().toLowerCase();

    if (ans === "q" || ans === "quit") return null;

    if (ans === "b" && searchMode) {
      list = allGotchis;
      searchMode = false;
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

    // Page tabs use tN so they never collide with list index 1…N
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
      const raw = (await rl.question("  Gotchi ID (# or number): ")).trim();
      const id = raw.replace(/^#/, "");
      if (!/^\d+$/.test(id)) {
        console.log("  invalid id — use digits only, e.g. 954");
        await pause();
        continue;
      }
      const found = allGotchis.find((g) => String(g.gotchiId) === id) ?? await fetchWalletGotchiById(wallet, id);
      if (!found) {
        console.log(`  #${id} not found in this wallet on Base`);
        await pause();
        continue;
      }
      list = [found];
      searchMode = true;
      page = 0;
      continue;
    }

    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= slice.length) {
      const picked = slice[n - 1];
      const ok = await confirmOwnedImport(picked);
      if (!ok) continue;
      return picked;
    }

    console.log("  invalid choice");
    await pause();
  }
}

async function pickCollateral(promptText) {
  console.log(`\n  ${promptText}\n`);
  COLLATERALS_16.forEach((c, i) => {
    const haunt = ["wbtc", "matic"].includes(c) ? "H2" : "H1";
    console.log(`    ${String(i + 1).padStart(2)} ) ${c.padEnd(6)} (${haunt})`);
  });
  for (;;) {
    const ans = (await rl.question("\n  Collateral [1-16]: ")).trim();
    const n = Number(ans);
    if (n >= 1 && n <= 16) return COLLATERALS_16[n - 1];
    console.log("  pick 1–16");
  }
}

async function resolveHeroes(wallet, cartridgeId) {
  let heroes = await fetchCartridgeHeroes(cartridgeId);
  if (heroes.length > 0) {
    console.log(`\n  ✓ ${heroes.length} cAavegotchi(s) on cartridge`);
    return heroes;
  }

  console.log("\n  No cAavegotchis on cartridge yet.");
  console.log("  Loading gotchis from subgraph…");
  const onChain = await fetchWalletGotchis(wallet);

  if (onChain.length > 0) {
    const pick = await pickOnChainGotchi(wallet, onChain);
    if (!pick) return heroes;
    console.log(`\n  Binding owned gotchi #${pick.gotchiId} (free)…`);
    const heroId = await apiOp("bind-owned", pick.gotchiId);
    console.log(`  ✓ bound ${heroId}`);
    heroes = await fetchCartridgeHeroes(cartridgeId);
    return heroes;
  }

  title("Mint your first cAavegotchi");
  console.log("  No Aavegotchis in this wallet on Base.");
  console.log("  Sim-mint a starter cAavegotchi (pick collateral):\n");
  const collateral = await pickCollateral("Choose collateral for orchestrator gotchi");
  console.log(`\n  Minting starter (${collateral})…`);
  const heroId = await apiOp("bind-starter", collateral);
  console.log(`  ✓ minted ${heroId}`);
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
      { key: "launch", label: "Launch orchestrator (OpenCode gotchi chat)" },
      { key: "mint", label: "Mint another cAavegotchi (sub-agent identity)" },
      { key: "avatar", label: "Change orchestrator avatar" },
    ]);
    if (!pick) process.exit(0);

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
      spawnSync("node", [`${ROOT}/scripts/tts.mjs`, "speak", "Orchestrator ready.", "--persona", "gotchi"], {
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

    if (pick.key === "mint") {
      const collateral = await pickCollateral("Mint sub-agent cAavegotchi — pick collateral");
      console.log(`\n  Minting sub-agent (${collateral})…`);
      const heroId = await apiOp("mint-sub", collateral);
      console.log(`  ✓ minted ${heroId} (available for sub-agent spawn)`);
      await pause();
      continue;
    }

    if (pick.key === "avatar") {
      const heroId = await pickOrchestrator(heroes);
      await apiOp("select-hero", heroId);
      pinAvatar(heroId);
      saveOnboarding({ orchestratorHeroId: heroId });
      console.log(`\n  ✓ orchestrator avatar → ${heroId}`);
      await pause();
    }
  }
}

async function run() {
  try {
    // Stale session pins (s2026…) are not hero ids — clear before onboarding.
    const pinPath = `${ROOT}/sessions/.pin`;
    try {
      const pin = readFileSync(pinPath, "utf8").trim();
      if (/^s\d/.test(pin)) unlinkSync(pinPath);
    } catch {}

    const wallet = await connectWalletMenu();

    const cartridgeId = await ensureCartridge(wallet);
    const heroes = await resolveHeroes(wallet, cartridgeId);

    if (!loadOnboarding().orchestratorHeroId) {
      title("Orchestrator avatar");
      const heroId = await pickOrchestrator(heroes);
      await apiOp("select-hero", heroId);
      pinAvatar(heroId);
      saveOnboarding({ orchestratorHeroId: heroId });
      console.log(`\n  ✓ orchestrator set → ${heroId}`);
      await pause();
    }

    await mainMenu(wallet, cartridgeId);
  } finally {
    rl.close();
  }
}

run().catch((e) => {
  console.error(`\n  ✗ ${e.message}`);
  process.exit(1);
});
