/**
 * Base set membership and the fe-marketing display title.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadCatalog,
  resolvePackScope,
  scopeLabel,
  STARTER_PACK_IDS,
} from "../scripts/template-pack.mjs";
import { wearableMarkup } from "../scripts/wearable-color.mjs";

const root = new URL("..", import.meta.url).pathname;

const BASE_SET = [
  "accountant",
  "architect",
  "auditor",
  "bend-crew",
  "brand-design",
  "chief-of-staff",
  "customer-support",
  "fe-marketing",
  "game-art-director",
  "jev",
  "kanban-manager",
  "mail-courier",
  "market-news",
  "market-research",
  "marketing-agency",
  "product-manager",
  "security-engineer",
  "social-media-manager",
  "worker",
];

describe("marketplace Base set", () => {
  it("labels the public set Base set and lists the roster", () => {
    assert.equal(scopeLabel("starter"), "Base set");
    assert.deepEqual([...STARTER_PACK_IDS].sort(), BASE_SET);
    const catalog = loadCatalog();
    const ids = catalog.packs.filter((p) => resolvePackScope(p) === "starter").map((p) => p.id).sort();
    assert.deepEqual(ids, BASE_SET);
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    assert.equal(fe.id, "fe-marketing");
    const pack = JSON.parse(readFileSync(join(root, "templates/marketplace/packs/fe-marketing/pack.json"), "utf8"));
    const playbook = JSON.parse(readFileSync(join(root, "templates/marketplace/packs/fe-marketing/playbook.json"), "utf8"));
    assert.equal(pack.title, "UI/UX");
    assert.equal(pack.id, "fe-marketing");
    assert.equal(playbook.title, "UI/UX");
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.match(html, /Base set/);
    assert.doesNotMatch(html.slice(0, html.indexOf("catalog-fallback")), /starter/);
  });

  it("renders Base set ASCII wearables and leaves the bend-crew suite without one", () => {
    const catalog = loadCatalog();
    const wearables = JSON.parse(readFileSync(join(root, "templates/marketplace/wearables.json"), "utf8"));
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    assert.equal(fe.wearable.name, "VR Headset");
    assert.equal(fe.wearable.id, 202);
    assert.equal(fe.wearable.ascii, wearables["fe-marketing"].ascii);
    assert.ok(fe.wearable.ascii.split("\n").length > 1);
    const crew = catalog.packs.find((p) => p.id === "bend-crew");
    assert.equal(crew.kind, "suite");
    assert.equal(crew.wearable, undefined);
    assert.equal(wearables["bend-crew"], undefined);
    assert.equal(wearables["prof-link-cube"], undefined);
    for (const id of [...BASE_SET, "bend-chief", "bend-laws", "bend-proofs"]) {
      if (id === "bend-crew") continue;
      const pack = catalog.packs.find((p) => p.id === id);
      assert.equal(typeof pack.wearable?.ascii, "string", id);
      assert.ok(pack.wearable.ascii.length > 0, id);
      const onDisk = JSON.parse(readFileSync(join(root, "templates/marketplace/packs", id, "pack.json"), "utf8"));
      assert.equal(onDisk.wearable.ascii, pack.wearable.ascii, id);
      assert.equal(onDisk.wearable.name, wearables[id].name, id);
    }
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.ok(html.includes('createElement("pre")'));
    assert.ok(html.includes('pre.className = "wearable"'));
    assert.equal(html.includes("assets/templates/"), false);
    assert.ok(html.includes("Trezor Wallet"));
  });
});

describe("marketplace wearable sprite colors", () => {
  // Majority opaque fills sampled from app.aavegotchi.com/images/items/{id}.svg.
  // Not collateral primary/secondary.
  const SPRITE_COLORS = {
    9: ["#000000", "#1e1e1e", "#323232", "#5a5a5a"],
    32: ["#7d0064", "#8e7064", "#ffffff"],
    41: ["#000000", "#00ff00", "#323232"],
    52: ["#000000", "#910091", "#be32be", "#e17dd7", "#ebaae6", "#ff32ff"],
    53: ["#00ff00", "#7d00ff", "#ff00ff", "#ffff00"],
    55: ["#000000", "#ff00ff"],
    65: ["#3a2b77", "#47289b", "#8000ff", "#b135ff", "#cb5bff", "#ffc9ff", "#ffffff"],
    75: ["#000000", "#205fec", "#88bdf3", "#ffffff"],
    84: ["#000000", "#282828"],
    137: ["#000000", "#7d7d7d", "#ff9900"],
    139: ["#000000", "#7d7d7d", "#ff9900"],
    149: ["#5f0087", "#8237a1", "#ff9e00", "#ffc03c", "#ffd781"],
    202: ["#000000", "#ff0097", "#ff14ff", "#ffffff"],
    212: ["#000000", "#00ff00", "#323232"],
    213: ["#000000", "#00ff00"],
    239: ["#960000", "#ffc900"],
    263: ["#000000", "#2800af", "#9b00a0", "#ff09d7"],
    355: ["#000000", "#2aa4ff", "#db3ffd"],
    364: ["#000000", "#2a2a2a", "#7d4100", "#ededed"],
    365: ["#00ff00", "#00ffff", "#7d00ff", "#d7c3b4", "#ff00ff", "#ffff00"],
    369: ["#176dad", "#23a3cf", "#3bccff", "#581693", "#7a15ad", "#ac14f8", "#bfdcff", "#bfffd2", "#f5fdff"],
  };
  const COLLATERAL_HEX = ["0000b9", "d4def8", "ff2a7a", "ffc3df", "fbdfeb", "b6509e", "cfeef4", "282473", "489ff8", "2664ba", "d4e0f1", "ff5e00", "ffcaa2"];

  function spanColors(markup) {
    return [...new Set([...markup.matchAll(/color:(#[0-9a-f]{6})/g)].map((m) => m[1]))].sort();
  }

  function pageWearableMarkup() {
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    const start = html.indexOf("/* wearable-markup */");
    const end = html.indexOf("/* /wearable-markup */");
    assert.ok(start >= 0 && end > start);
    const src = html.slice(start, end);
    const fnStart = src.indexOf("function wearableMarkup");
    return new Function(`${src.slice(fnStart)}\nreturn wearableMarkup;`)();
  }

  it("uses stored sprite-cell markup, not collateral primary/secondary", () => {
    const catalog = loadCatalog();
    const wearables = JSON.parse(readFileSync(join(root, "templates/marketplace/wearables.json"), "utf8"));
    const page = pageWearableMarkup();
    const pageSrc = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.equal(pageSrc.includes("pre.dataset.primary"), false);
    assert.equal(pageSrc.includes("pre.dataset.secondary"), false);
    assert.equal(pageSrc.includes("aavegotchi.com/images/items/"), false);
    assert.match(pageSrc, /pre\.innerHTML = colored/);
    assert.match(pageSrc, /colored == null/);
    const seen = new Set();
    for (const [roleId, row] of Object.entries(wearables)) {
      assert.notEqual(row.id, 17, roleId);
      assert.equal(SPRITE_COLORS[row.id] != null, true, roleId);
      const pack = catalog.packs.find((p) => p.id === roleId);
      assert.equal(pack.wearable.ascii, row.ascii, roleId);
      assert.equal(pack.wearable.markup, row.markup, roleId);
      assert.equal(pack.wearable.primary, undefined, roleId);
      assert.equal(pack.wearable.secondary, undefined, roleId);
      assert.equal(pack.wearable.gotchiId, undefined, roleId);
      const markup = wearableMarkup(row.ascii, row);
      assert.equal(markup, row.markup, roleId);
      assert.equal(markup, page(row.ascii, row), roleId);
      assert.deepEqual(spanColors(markup), SPRITE_COLORS[row.id], roleId);
      for (const hex of COLLATERAL_HEX) {
        assert.equal(markup.includes(`#${hex}`), false, `${roleId} ${hex}`);
      }
      const onDisk = JSON.parse(readFileSync(join(root, "templates/marketplace/packs", roleId, "pack.json"), "utf8"));
      assert.equal(onDisk.wearable.markup, row.markup, roleId);
      assert.equal(onDisk.wearable.primary, undefined, roleId);
      seen.add(row.id);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), Object.keys(SPRITE_COLORS).map(Number).sort((a, b) => a - b));
    const support = wearables["customer-support"];
    assert.equal(
      support.markup,
      '<span style="color:#ff00ff">█</span> \n<span style="color:#000000">▀</span> \n  \n  ',
    );
    assert.equal(wearableMarkup(support.ascii, { gotchiId: "owned-5402", primary: "b6509e", secondary: "cfeef4" }), null);
    assert.equal(wearableMarkup(support.ascii, { markup: support.markup + "<script>" }), null);
    assert.equal(wearableMarkup(support.ascii + "x", support), null);
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    assert.equal(fe.wearable.id, 202);
    assert.deepEqual(spanColors(fe.wearable.markup), SPRITE_COLORS[202]);
    assert.equal(catalog.packs.find((p) => p.id === "bend-crew").wearable, undefined);
    assert.equal(catalog.packs.find((p) => p.id === "prof-link-cube")?.wearable, undefined);
    assert.equal(wearables["bend-crew"], undefined);
    assert.equal(wearables["prof-link-cube"], undefined);
    assert.equal(catalog.packs.some((p) => p.wearable && p.wearable.id === 17), false);
  });
});
