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
import { findCollateralColors } from "../scripts/collateral-resolve.mjs";
import { PRIMARY_CHARS, SECONDARY_CHARS, wearableMarkup } from "../scripts/wearable-color.mjs";

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

describe("marketplace wearable collateral colors", () => {
  const LINK_CUBE = [
    "  ▄▄  ",
    " ▄█░▄ ",
    "▄██░░▄",
    "▓▒█░▒▓",
    "▓▓▒▒▓▓",
    "▀▓▒▒▓▀",
    " ▀░░▀ ",
    "  ▀▀  ",
  ].join("\n");

  function pageWearableMarkup() {
    const html = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    const start = html.indexOf("/* wearable-markup */");
    const end = html.indexOf("/* /wearable-markup */");
    assert.ok(start >= 0 && end > start);
    const src = html.slice(start, end);
    const fnStart = src.indexOf("function wearableMarkup");
    return new Function(`${src.slice(fnStart)}\nreturn wearableMarkup;`)();
  }

  it("colors Link Cube shades with the bound gotchi primary and secondary", () => {
    const link = findCollateralColors("link", 1);
    const page = pageWearableMarkup();
    const wearable = { gotchiId: "owned-5041", primary: link.primary, secondary: link.secondary };
    const html = wearableMarkup(LINK_CUBE, wearable);
    assert.equal(html, page(LINK_CUBE, wearable));
    assert.match(html, new RegExp(`<span style="color:#${link.primary}">█</span>`));
    assert.match(html, new RegExp(`<span style="color:#${link.secondary}">░</span>`));
    assert.match(html, new RegExp(`<span style="color:#${link.secondary}">▒</span>`));
    assert.match(html, new RegExp(`<span style="color:#${link.primary}">▓</span>`));
    assert.equal(wearableMarkup(LINK_CUBE, { primary: link.primary, secondary: link.secondary }), null);
    assert.equal(wearableMarkup(LINK_CUBE, { gotchiId: "owned-5041" }), null);
    const pageSrc = readFileSync(join(root, "templates/marketplace/web/index.html"), "utf8");
    assert.match(pageSrc, /pre\.dataset\.primary/);
    assert.match(pageSrc, /pre\.dataset\.secondary/);
    assert.match(pageSrc, /colored == null/);
  });

  it("puts those two colors on Base set wearables that have a bound gotchi", () => {
    const catalog = loadCatalog();
    const roles = JSON.parse(readFileSync(join(root, "config/agent-roles.json"), "utf8"));
    const bound = JSON.parse(readFileSync(join(root, "templates/marketplace/bound-gotchis.json"), "utf8"));
    const fe = catalog.packs.find((p) => p.id === "fe-marketing");
    assert.equal(fe.title, "UI/UX");
    const link = findCollateralColors("link", 1);
    assert.equal(fe.wearable.primary, link.primary);
    assert.equal(fe.wearable.secondary, link.secondary);
    assert.equal(roles[fe.wearable.gotchiId], "fe-marketing");
    for (const [roleId, row] of Object.entries(bound)) {
      assert.equal(roles[row.gotchiId], roleId, roleId);
      const colors = findCollateralColors(row.collateral, row.hauntId);
      const pack = catalog.packs.find((p) => p.id === roleId);
      assert.equal(pack.wearable.primary, colors.primary, roleId);
      assert.equal(pack.wearable.secondary, colors.secondary, roleId);
      const markup = wearableMarkup(pack.wearable.ascii, pack.wearable);
      const glyphs = [...pack.wearable.ascii];
      if (glyphs.some((ch) => PRIMARY_CHARS.includes(ch))) {
        assert.match(markup, new RegExp(`#${colors.primary}`), roleId);
      }
      if (glyphs.some((ch) => SECONDARY_CHARS.includes(ch))) {
        assert.match(markup, new RegExp(`#${colors.secondary}`), roleId);
      }
      const onDisk = JSON.parse(readFileSync(join(root, "templates/marketplace/packs", roleId, "pack.json"), "utf8"));
      assert.equal(onDisk.wearable.primary, colors.primary, roleId);
      assert.equal(onDisk.wearable.secondary, colors.secondary, roleId);
    }
    const architect = catalog.packs.find((p) => p.id === "architect");
    const arch = wearableMarkup(architect.wearable.ascii, architect.wearable);
    assert.match(arch, new RegExp(`#${architect.wearable.primary}`));
    assert.match(arch, new RegExp(`#${architect.wearable.secondary}`));
    for (const id of ["worker", "product-manager", "auditor", "brand-design", "game-art-director", "jev", "security-engineer"]) {
      const pack = catalog.packs.find((p) => p.id === id);
      assert.equal(pack.wearable.gotchiId, undefined, id);
      assert.equal(pack.wearable.primary, undefined, id);
      assert.equal(wearableMarkup(pack.wearable.ascii, pack.wearable), null, id);
    }
    assert.equal(catalog.packs.find((p) => p.id === "bend-crew").wearable, undefined);
    assert.equal(bound["bend-crew"], undefined);
    assert.equal(bound["prof-link-cube"], undefined);
  });
});
