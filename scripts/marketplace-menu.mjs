#!/usr/bin/env node
/**
 * marketplace-menu.mjs — native GotchiBot Marketplace (TUI).
 *
 * Pulls catalog from https://aarcadeghst.com/gotchibot-templates (Vercel),
 * then templates.aarcadeghst.com; falls back to local marketplace when both fail.
 *
 *   node scripts/marketplace-menu.mjs
 *   ./scripts/gotchibot marketplace
 *   ./scripts/gotchibot templates menu
 */
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import {
  BASE_URL,
  loadCatalog,
  loadCatalogPreferRemote,
  remotePackUrl,
  resolvePackScope,
  filterPacksByScope,
  isNpcPack,
  isSuitePack,
  suiteMembers,
} from "./template-pack.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSIONS = join(ROOT, "sessions");
const PACK_CLI = join(ROOT, "scripts", "template-pack.mjs");

const SCOPE_LABEL = {
  starter: "starter templates",
  aarcade: "AarcadeGh-t / desk",
  all: "all scopes",
};

function title(t) {
  console.log(`\n  ── ${t} ──\n`);
}

async function choose(rl, prompt, options) {
  console.log("");
  options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}`));
  console.log(`    b) Back`);
  for (;;) {
    const ans = (await rl.question(`\n  ${prompt} [1-${options.length}]: `)).trim().toLowerCase();
    if (ans === "b" || ans === "back" || ans === "q" || ans === "quit") return null;
    const n = Number(ans);
    if (n >= 1 && n <= options.length) return options[n - 1];
    console.log("  invalid choice");
  }
}

async function pause(rl) {
  await rl.question("\n  [enter] ");
}

function loadHeroCandidates() {
  const ids = new Set();
  try {
    const meta = JSON.parse(readFileSync(join(SESSIONS, ".identity.json"), "utf8"));
    if (meta.activeHeroId) ids.add(String(meta.activeHeroId));
  } catch {
    /* ignore */
  }
  try {
    const roster = JSON.parse(readFileSync(join(SESSIONS, ".avatar-roster.json"), "utf8"));
    const list = roster.heroes || roster.roster || [];
    for (const h of list) {
      const id = typeof h === "string" ? h : h?.id;
      if (id) ids.add(String(id));
    }
  } catch {
    /* ignore */
  }
  try {
    const onboard = JSON.parse(readFileSync(join(SESSIONS, ".onboarding.json"), "utf8"));
    if (onboard.orchestratorHeroId) ids.add(String(onboard.orchestratorHeroId));
  } catch {
    /* ignore */
  }
  return [...ids];
}

function runPack(args) {
  const r = spawnSync(process.execPath, [PACK_CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

function runPackInherit(args) {
  const r = spawnSync(process.execPath, [PACK_CLI, ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return r.status ?? 1;
}

function packInstalled(packId) {
  return existsSync(join(ROOT, "templates", "marketplace", "packs", packId, "pack.json"));
}

async function pickHero(rl) {
  const heroes = loadHeroCandidates();
  if (heroes.length === 0) {
    const typed = (await rl.question("  Hero id (e.g. owned-22899): ")).trim();
    return typed || null;
  }
  const opts = heroes.map((id) => ({ key: id, label: id }));
  opts.push({ key: "__type", label: "Type a different hero id…" });
  const pick = await choose(rl, "Apply to which hero?", opts);
  if (!pick) return null;
  if (pick.key === "__type") {
    const typed = (await rl.question("  Hero id: ")).trim();
    return typed || null;
  }
  return pick.key;
}

async function packDetail(rl, catalog, pack) {
  for (;;) {
    title(pack.title || pack.id);
    const url = remotePackUrl(catalog, pack.id);
    const local = packInstalled(pack.id) ? "yes" : "no";
    console.log(`  id         ${pack.id}`);
    console.log(`  scope      ${resolvePackScope(pack)}`);
    if (isNpcPack(pack)) console.log(`  kind       npc (install only — never seats a hero)`);
    if (isSuitePack(pack)) {
      console.log(`  kind       suite`);
      console.log(`  members    ${suiteMembers(pack).join(", ")}`);
    }
    console.log(`  version    ${pack.version || "?"}`);
    console.log(`  summary    ${pack.summary || "-"}`);
    console.log(`  tags       ${(pack.tags || []).join(", ") || "-"}`);
    console.log(`  skills     ${(pack.skills || []).join(", ") || "-"}`);
    if (pack.skillsExternal?.length) {
      console.log(`  external   ${pack.skillsExternal.join(", ")}`);
    }
    console.log(`  source     ${sourceLabel(catalog)}`);
    console.log(`  on disk    ${local}`);
    console.log(`  pack URL   ${url}`);
    console.log("");

    const actions = isNpcPack(pack)
      ? [
          { key: "install", label: "Install NPC (playbook + skill + config/npc)" },
          { key: "show", label: "Show pack.json / files (local)" },
        ]
      : isSuitePack(pack)
        ? [
            { key: "install", label: "Install suite (all member playbooks + skills)" },
            { key: "apply", label: "Seat suite (pick a hero per member)" },
            { key: "show", label: "Show pack.json / files (local)" },
          ]
      : [
          { key: "install", label: "Install pack (merge playbook / AGENTS / skills)" },
          { key: "apply", label: "Apply to hero (install + resummon + slot 15)" },
          { key: "show", label: "Show pack.json / files (local)" },
        ];
    const act = await choose(rl, "Action?", actions);
    if (!act) return;

    if (act.key === "install") {
      const target = catalog.source === "remote" ? url : pack.id;
      console.log(`\n  Installing ${pack.id}…`);
      runPackInherit(["install", target, "--yes"]);
      await pause(rl);
      continue;
    }

    if (act.key === "apply") {
      if (isNpcPack(pack)) {
        console.log("\n  NPC — use Install, not Apply-to-hero.");
        await pause(rl);
        continue;
      }
      if (isSuitePack(pack)) {
        const members = suiteMembers(pack);
        const pairs = [];
        for (const m of members) {
          console.log(`\n  Member ${m}:`);
          const h = await pickHero(rl);
          if (!h) {
            console.log("  cancelled suite seating");
            await pause(rl);
            return;
          }
          pairs.push(`${m}=${h}`);
        }
        console.log(`\n  Seat suite ${pack.id} → ${pairs.join(", ")}…`);
        if (catalog.source === "remote" && !packInstalled(pack.id)) {
          runPackInherit(["install", url, "--yes"]);
        }
        runPackInherit(["apply", pack.id, "--heroes", pairs.join(","), "--yes"]);
        await pause(rl);
        continue;
      }
      const hero = await pickHero(rl);
      if (!hero) continue;
      console.log(`\n  Apply ${pack.id} → ${hero}…`);
      if (catalog.source === "remote" && !packInstalled(pack.id)) {
        runPackInherit(["install", url, "--yes"]);
      }
      runPackInherit(["apply", pack.id, "--hero", hero, "--yes"]);
      await pause(rl);
      continue;
    }

    if (act.key === "show") {
      if (!packInstalled(pack.id)) {
        console.log("\n  Pack not on disk yet — install first (or CDN is down and pack was never packed locally).");
      } else {
        runPack(["show", pack.id]);
      }
      await pause(rl);
    }
  }
}

function sourceLabel(catalog) {
  if (catalog?.source === "remote") {
    return `CDN · ${catalog.packs?.length ?? 0} packs · ${catalog.catalogUrl || BASE_URL}`;
  }
  return `local · ${catalog.packs?.length ?? 0} packs${catalog?.remoteError ? ` (CDN: ${catalog.remoteError})` : ""}`;
}

function scopeCounts(catalog) {
  let starter = 0;
  let aarcade = 0;
  for (const p of catalog.packs || []) {
    if (resolvePackScope(p) === "starter") starter += 1;
    else aarcade += 1;
  }
  return { starter, aarcade, total: (catalog.packs || []).length };
}

async function browsePacks(rl, catalog, scope) {
  const packs = [...filterPacksByScope(catalog.packs || [], scope)].sort((a, b) =>
    String(a.title || a.id).localeCompare(String(b.title || b.id)),
  );
  for (;;) {
    title("Browse packs");
    console.log(`  source  ${sourceLabel(catalog)}`);
    console.log(`  filter  ${SCOPE_LABEL[scope] || scope} · showing ${packs.length}`);
    console.log("");
    if (packs.length === 0) {
      console.log("  (no packs in this filter)");
      await pause(rl);
      return;
    }
    const opts = packs.map((p) => ({
      key: p.id,
      label: `${p.title || p.id}  (v${p.version || "?"} · ${resolvePackScope(p)}${isNpcPack(p) ? " · NPC" : ""}${isSuitePack(p) ? " · suite" : ""})`,
      pack: p,
    }));
    const pick = await choose(rl, "Open pack?", opts);
    if (!pick) return;
    await packDetail(rl, catalog, pick.pack);
  }
}

async function searchPacks(rl, catalog, scope) {
  const q = (await rl.question("  Search (title / id / tag): ")).trim().toLowerCase();
  if (!q) return;
  const hits = filterPacksByScope(catalog.packs || [], scope).filter((p) => {
    const blob = [
      p.id,
      p.roleId,
      p.title,
      p.summary,
      p.scope,
      ...(p.tags || []),
      ...(p.skills || []),
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });
  if (hits.length === 0) {
    console.log("  No matches.");
    await pause(rl);
    return;
  }
  const opts = hits.map((p) => ({
    key: p.id,
    label: `${p.title || p.id}  (v${p.version || "?"} · ${resolvePackScope(p)})`,
    pack: p,
  }));
  const pick = await choose(rl, "Open pack?", opts);
  if (!pick) return;
  await packDetail(rl, catalog, pick.pack);
}

export async function runMarketplaceMenu() {
  const rl = readline.createInterface({ input, output });
  try {
    title("Marketplace");
    console.log(`  Pulling catalog from ${BASE_URL} …`);
    let catalog = await loadCatalogPreferRemote();
    let scope = "starter"; // default public offer
    const localCatalog = {
      ...loadCatalog(),
      source: "local",
      baseUrl: BASE_URL,
    };

    const printSource = () => {
      const counts = scopeCounts(catalog);
      if (catalog.source === "remote") {
        console.log(`  ✓ ${sourceLabel(catalog)}`);
        if (localCatalog.packs?.length && localCatalog.packs.length !== catalog.packs.length) {
          console.log(
            `  · desk local has ${localCatalog.packs.length} packs (${localCatalog.packs.length - catalog.packs.length} not published to CDN yet)`,
          );
        }
      } else {
        console.log(`  · ${sourceLabel(catalog)}`);
        console.log(`  · Fix: ./scripts/gotchibot templates cdn deploy --yes`);
      }
      console.log(
        `  scopes   ${counts.starter} starter · ${counts.aarcade} AarcadeGh-t/desk · filter=${scope}`,
      );
      console.log(`  install base  ${catalog.baseUrl || BASE_URL}`);
    };
    printSource();

    for (;;) {
      const visible = filterPacksByScope(catalog.packs || [], scope).length;
      const pick = await choose(rl, "Marketplace", [
        {
          key: "browse",
          label: `Browse ${SCOPE_LABEL[scope]} (${visible})`,
        },
        { key: "search", label: `Search ${SCOPE_LABEL[scope]}` },
        {
          key: "scope",
          label:
            scope === "starter"
              ? "Show AarcadeGh-t / desk packs"
              : scope === "aarcade"
                ? "Show all packs"
                : "Show starter templates only",
        },
        {
          key: "toggle",
          label:
            catalog.source === "remote"
              ? `Switch to desk local (${localCatalog.packs?.length ?? 0} packs)`
              : `Switch to CDN pull (${BASE_URL})`,
        },
        { key: "refresh", label: "Refresh catalog (re-pull CDN)" },
        { key: "web", label: "Open CDN in browser" },
        { key: "done", label: "Done" },
      ]);
      if (!pick || pick.key === "done") return;

      if (pick.key === "browse") {
        await browsePacks(rl, catalog, scope);
        continue;
      }
      if (pick.key === "search") {
        await searchPacks(rl, catalog, scope);
        continue;
      }
      if (pick.key === "scope") {
        scope = scope === "starter" ? "aarcade" : scope === "aarcade" ? "all" : "starter";
        console.log(`\n  Filter → ${SCOPE_LABEL[scope]} (${filterPacksByScope(catalog.packs || [], scope).length})`);
        await pause(rl);
        continue;
      }
      if (pick.key === "toggle") {
        if (catalog.source === "remote") {
          catalog = { ...localCatalog };
          console.log(`\n  Switched → ${sourceLabel(catalog)}`);
        } else {
          console.log(`\n  Re-pulling ${BASE_URL}/catalog.json …`);
          catalog = await loadCatalogPreferRemote();
          printSource();
        }
        await pause(rl);
        continue;
      }
      if (pick.key === "refresh") {
        console.log(`\n  Re-pulling ${BASE_URL}/catalog.json …`);
        catalog = await loadCatalogPreferRemote();
        printSource();
        await pause(rl);
        continue;
      }
      if (pick.key === "web") {
        try {
          spawnSync("open", [BASE_URL], { stdio: "ignore" });
          console.log(`  Opened ${BASE_URL}`);
        } catch {
          console.log(`  Open: ${BASE_URL}`);
        }
        await pause(rl);
      }
    }
  } finally {
    rl.close();
  }
}

const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMain) {
  runMarketplaceMenu().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
