/**
 * template-pack apply gate — SLICE 1 rule 3 (+ review fixes).
 *   node --test tests/template-apply-gate.test.mjs
 *
 * No network: inject fake fetchRoster / statusOf.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "gotchibot-gate-"));
process.env.GOTCHIBOT_SESSIONS_DIR = tmp;
mkdirSync(join(tmp, "pstack"), { recursive: true });

const gateUrl = pathToFileURL(join(root, "scripts", "hero-apply-gate.mjs")).href;
const pcUrl = pathToFileURL(join(root, "scripts", "project-context.mjs")).href;

const {
  assertHeroApplicable,
  matchSepoliaHeroBytes32,
  sepoliaRosterMembership,
  STANDING_DESK_HEROES,
} = await import(`${gateUrl}?t=${Date.now()}`);
const { ensureProjectDirs, saveRoster } = await import(`${pcUrl}?t=${Date.now()}`);

function seedCrew(slug, heroes) {
  ensureProjectDirs(slug);
  writeFileSync(
    join(tmp, "pstack", slug, "dossier.json"),
    `${JSON.stringify({ project: slug }, null, 2)}\n`,
  );
  saveRoster({ heroes }, slug);
}

/** Minimal ethers-like for offline bytes32 tests. */
function fakeEthers() {
  function encodeBytes32String(s) {
    const buf = Buffer.alloc(32);
    const b = Buffer.from(String(s), "utf8");
    if (b.length > 31) throw new Error("too long");
    b.copy(buf);
    return "0x" + buf.toString("hex");
  }
  function decodeBytes32String(hex) {
    const h = String(hex).replace(/^0x/i, "");
    if (h.length !== 64) throw new Error("bad len");
    const buf = Buffer.from(h, "hex");
    let end = buf.indexOf(0);
    if (end < 0) end = 32;
    return buf.slice(0, end).toString("utf8");
  }
  function id(s) {
    return "0x" + createHash("sha256").update(String(s)).digest("hex");
  }
  return { encodeBytes32String, decodeBytes32String, id };
}

after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.GOTCHIBOT_APPLY_GATE_OK;
});

const ROSTER = ["starter-dai-h1-2", "owned-99", "owned-954", "starter-link-h1-1", "busy-starter"];

describe("assertHeroApplicable", () => {
  it("refuses busy hero (status active)", async () => {
    const r = await assertHeroApplicable("starter-dai-h1-2", {
      project: "proj-x",
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "active",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /active|available/i.test(x)));
  });

  it("refuses hero not on roster", async () => {
    const r = await assertHeroApplicable("starter-dai-h1-9", {
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /not on the user's cartridge roster/i.test(x)));
  });

  it("refuses unknown/empty hero id", async () => {
    const r = await assertHeroApplicable("", {
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /required|empty/i.test(x)));
  });

  it("refuses starter in another project's crew", async () => {
    seedCrew("other-proj", ["starter-dai-h1-2"]);
    const r = await assertHeroApplicable("starter-dai-h1-2", {
      project: "this-proj",
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /other-proj|crew/i.test(x)));
  });

  it("no project: starter on exactly one crew → allow with warning", async () => {
    // Fresh starter id so prior tests' crews do not leak
    seedCrew("only-crew", ["starter-usdc-h1-1"]);
    const roster = [...ROSTER, "starter-usdc-h1-1"];
    const r = await assertHeroApplicable("starter-usdc-h1-1", {
      project: null,
      fetchRoster: async () => ({ heroes: roster, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /only-crew/i.test(w)));
  });

  it("no project: starter on 2+ crews → refuse naming them", async () => {
    // Legacy inconsistent state: write roster.json directly (saveRoster would refuse).
    for (const slug of ["crew-a", "crew-b"]) {
      ensureProjectDirs(slug);
      writeFileSync(
        join(tmp, "pstack", slug, "dossier.json"),
        `${JSON.stringify({ project: slug }, null, 2)}\n`,
      );
      writeFileSync(
        join(tmp, "pstack", slug, "roster.json"),
        `${JSON.stringify({ heroes: ["starter-weth-h1-1"] }, null, 2)}\n`,
      );
    }
    const roster = [...ROSTER, "starter-weth-h1-1"];
    const r = await assertHeroApplicable("starter-weth-h1-1", {
      project: null,
      fetchRoster: async () => ({ heroes: roster, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /crew-a/i.test(x) && /crew-b/i.test(x)));
  });

  it("uses SIM agentStatus from roster objects (ignores statusOf)", async () => {
    const r = await assertHeroApplicable("owned-99", {
      fetchRoster: async () => ({
        heroes: [{ id: "owned-99", agentStatus: "working", bindType: "owned" }],
        source: "sim",
      }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /working/i.test(x)));
  });

  it("SIM missing agentStatus defaults to available", async () => {
    const r = await assertHeroApplicable("owned-99", {
      fetchRoster: async () => ({
        heroes: [{ id: "owned-99", bindType: "bindOwned" }],
        source: "sim",
      }),
      statusOf: () => "active",
    });
    assert.equal(r.ok, true);
  });

  it("GOTCHIBOT_APPLY_GATE_OK=1 skips even with force", async () => {
    process.env.GOTCHIBOT_APPLY_GATE_OK = "1";
    try {
      const r = await assertHeroApplicable("owned-954", {
        force: true,
        fetchRoster: async () => {
          throw new Error("should not fetch");
        },
        statusOf: () => "active",
      });
      assert.equal(r.ok, true);
      assert.ok(r.warnings.some((w) => /GOTCHIBOT_APPLY_GATE_OK/i.test(w)));
    } finally {
      delete process.env.GOTCHIBOT_APPLY_GATE_OK;
    }
  });

  it("refuses orchestrator owned-954", async () => {
    const r = await assertHeroApplicable("owned-954", {
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((x) => /orchestrator/i.test(x)));
  });

  it("--force override returns ok with warning", async () => {
    const r = await assertHeroApplicable("owned-954", {
      force: true,
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /WARNING|--force/i.test(w)));
  });

  it("offline roster fetch falls back to local with warning", async () => {
    writeFileSync(
      join(tmp, ".hero-agent-state.json"),
      `${JSON.stringify({ "owned-99": { status: "available" } }, null, 2)}\n`,
    );
    const r = await assertHeroApplicable("owned-99", {
      fetchRoster: async () => {
        throw new Error("network down");
      },
      statusOf: () => "available",
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /fallback|offline|failed/i.test(w)));
  });

  it("available owned on roster passes", async () => {
    const r = await assertHeroApplicable("owned-99", {
      fetchRoster: async () => ({ heroes: ROSTER, source: "fake" }),
      statusOf: () => "available",
    });
    assert.equal(r.ok, true);
    assert.equal(r.reasons.length, 0);
  });

  it("shares STANDING_DESK_HEROES with hero-agent-state", async () => {
    const stateUrl = pathToFileURL(join(root, "scripts", "hero-agent-state.mjs")).href;
    const { STANDING_DESK_HEROES: fromState } = await import(`${stateUrl}?t=${Date.now()}`);
    assert.deepEqual([...STANDING_DESK_HEROES].sort(), [...fromState].sort());
  });
});

describe("sepolia bytes32 matcher", () => {
  const eth = fakeEthers();

  it("matches encodeBytes32String and decode", () => {
    const id = "owned-123";
    const enc = eth.encodeBytes32String(id);
    assert.equal(matchSepoliaHeroBytes32(enc, id, eth), true);
    assert.equal(matchSepoliaHeroBytes32(eth.id(id), id, eth), true);
    assert.equal(matchSepoliaHeroBytes32(enc, "owned-999", eth), false);
  });

  it("unknown when undecodable and no ethers", () => {
    const junk = ["0x" + "ab".repeat(32)];
    assert.equal(sepoliaRosterMembership(junk, "owned-1", null), "unknown");
  });

  it("sepolia unknown membership falls back to local cache (warning)", async () => {
    writeFileSync(
      join(tmp, ".hero-agent-state.json"),
      `${JSON.stringify({ "owned-77": { status: "available" } }, null, 2)}\n`,
    );
    const r = await assertHeroApplicable("owned-77", {
      fetchRoster: async () => ({
        heroes: ["0x" + "ff".repeat(32)],
        source: "sepolia",
      }),
      statusOf: () => "available",
      ethersLike: null,
    });
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => /bytes32|unknown|fallback/i.test(w)));
  });
});

describe("install needs no gotchi", () => {
  it("install path does not call apply gate (error is about pack, not hero)", () => {
    const r = spawnSync(
      process.execPath,
      ["scripts/template-pack.mjs", "install", "definitely-not-a-real-pack-xyz"],
      { cwd: root, encoding: "utf8" },
    );
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    assert.notEqual(r.status, 0);
    assert.ok(
      /pack|catalog|unknown|not found|resolve|ENOENT|missing/i.test(out),
      `unexpected install error: ${out.slice(0, 400)}`,
    );
    assert.ok(!/apply gate|hero id is required|--hero/i.test(out));
  });

  it("install --help / usage mentions no hero for install", () => {
    const r = spawnSync(process.execPath, ["scripts/template-pack.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    assert.match(out, /install/);
    assert.match(out, /apply/);
  });
});

describe("marketplace launcher", () => {
  it("onboarding-gate no longer references marketplace-menu.mjs", () => {
    const src = readFileSync(join(root, "scripts", "onboarding-gate.mjs"), "utf8");
    assert.ok(!src.includes("marketplace-menu.mjs"));
    assert.ok(src.includes("template-pack.mjs"));
  });

  it("gotchibot marketplace routes to template-pack list", () => {
    const src = readFileSync(join(root, "scripts", "gotchibot"), "utf8");
    assert.ok(!src.includes("marketplace-menu.mjs"));
    assert.match(src, /template-pack\.mjs.*list/);
  });
});
