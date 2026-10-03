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
});
