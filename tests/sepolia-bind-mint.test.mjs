/**
 * Sepolia bindOwned/bindStarter + hero readback helpers.
 * No network / no browser.
 *   node --test tests/sepolia-bind-mint.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const mintUrl = pathToFileURL(join(root, "scripts", "cartridge-mint-sepolia.mjs")).href;
const rbUrl = pathToFileURL(join(root, "scripts", "hero-mint-readback.mjs")).href;

const prevOwned = process.env.CARTRIDGE_BIND_OWNED_ABI;
const prevStarter = process.env.CARTRIDGE_BIND_STARTER_ABI;

after(() => {
  if (prevOwned === undefined) delete process.env.CARTRIDGE_BIND_OWNED_ABI;
  else process.env.CARTRIDGE_BIND_OWNED_ABI = prevOwned;
  if (prevStarter === undefined) delete process.env.CARTRIDGE_BIND_STARTER_ABI;
  else process.env.CARTRIDGE_BIND_STARTER_ABI = prevStarter;
});

describe("resolveBindAbi / ABI_MISSING", () => {
  it("runBindOwned returns ABI_MISSING (not TypeError) without ABI", async () => {
    delete process.env.CARTRIDGE_BIND_OWNED_ABI;
    const { runBindOwned, resolveBindAbi } = await import(`${mintUrl}?abi=${Date.now()}`);
    assert.equal(resolveBindAbi("owned"), null);
    const r = await runBindOwned({
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      sourceTokenId: "22899",
      signTx: async () => {
        throw new Error("signTx must not be called");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ABI_MISSING");
    assert.match(r.error, /bindOwnedAbi|ABI missing/i);
  });

  it("runBindStarter returns ABI_MISSING without ABI", async () => {
    delete process.env.CARTRIDGE_BIND_STARTER_ABI;
    const { runBindStarter } = await import(`${mintUrl}?abi2=${Date.now()}`);
    const r = await runBindStarter({
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      templateId: "dai",
      collateral: "0x0000000000000000000000000000000000000001",
      signTx: async () => {
        throw new Error("signTx must not be called");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ABI_MISSING");
    assert.match(r.error, /bindStarterAbi|ABI missing/i);
  });
});

describe("injected ABI + mocked signTx", () => {
  it("runBindOwned encodes named-input calldata and calls signTx with diamond + chainId 84532", async () => {
    process.env.CARTRIDGE_BIND_OWNED_ABI =
      "function bindOwned(uint256 cartridgeId, uint256 sourceTokenId)";
    const { runBindOwned } = await import(`${mintUrl}?enc=${Date.now()}`);
    let seen = null;
    const r = await runBindOwned({
      expectWallet: "0x" + "ab".repeat(20),
      cartridgeId: "42",
      sourceTokenId: "22899",
      signTx: async (plan) => {
        seen = plan;
        return { ok: true, txHash: "0xdead" };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.txHash, "0xdead");
    assert.ok(seen);
    assert.equal(seen.chainId, 84532);
    assert.match(String(seen.to), /^0x[a-fA-F0-9]{40}$/);
    assert.match(String(seen.data), /^0x[0-9a-fA-F]+$/);
    assert.ok(seen.data.length > 10);
  });

  it("runBindStarter with named-input ABI hits signTx", async () => {
    process.env.CARTRIDGE_BIND_STARTER_ABI =
      "function bindStarter(uint256 cartridgeId, string templateId, address collateral)";
    const { runBindStarter } = await import(`${mintUrl}?enc2=${Date.now()}`);
    let seen = null;
    const r = await runBindStarter({
      expectWallet: "0x" + "cd".repeat(20),
      cartridgeId: "7",
      templateId: "dai",
      collateral: "0x00000000000000000000000000000000000000aa",
      signTx: async (plan) => {
        seen = plan;
        return { ok: true, txHash: "0xbeef" };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(seen.chainId, 84532);
    assert.match(String(seen.to), /^0x[a-fA-F0-9]{40}$/);
    assert.match(String(seen.data), /^0x[0-9a-fA-F]+$/);
  });

  it("named aliases (cartId/gotchiId) encode via mocked signTx", async () => {
    process.env.CARTRIDGE_BIND_OWNED_ABI =
      "function bindOwned(uint256 cartId, uint256 gotchiId)";
    const { runBindOwned, encodeBindCalldata } = await import(`${mintUrl}?alias=${Date.now()}`);
    const enc = await encodeBindCalldata("owned", process.env.CARTRIDGE_BIND_OWNED_ABI, {
      cartridgeId: "9",
      sourceTokenId: "100",
    });
    assert.match(String(enc.data), /^0x[0-9a-fA-F]+$/);
    assert.equal(enc.functionName, "bindOwned");

    let seen = null;
    const r = await runBindOwned({
      expectWallet: "0x" + "ef".repeat(20),
      cartridgeId: "9",
      sourceTokenId: "100",
      signTx: async (plan) => {
        seen = plan;
        return { ok: true, txHash: "0xcafe" };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(seen.data, enc.data);
  });
});

describe("ABI_UNSUPPORTED (unnamed / unknown inputs)", () => {
  it("unnamed inputs → ABI_UNSUPPORTED (no signTx)", async () => {
    process.env.CARTRIDGE_BIND_OWNED_ABI = "function bindOwned(uint256, uint256)";
    const { runBindOwned } = await import(`${mintUrl}?unnamed=${Date.now()}`);
    const r = await runBindOwned({
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      sourceTokenId: "2",
      signTx: async () => {
        throw new Error("signTx must not be called");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ABI_UNSUPPORTED");
    assert.match(r.error, /unsupported bind ABI fragment/i);
  });

  it("unknown input name → ABI_UNSUPPORTED", async () => {
    process.env.CARTRIDGE_BIND_STARTER_ABI =
      "function bindStarter(uint256 cartridgeId, string weirdName, address collateral)";
    const { runBindStarter, encodeBindCalldata } = await import(`${mintUrl}?unk=${Date.now()}`);
    await assert.rejects(
      () =>
        encodeBindCalldata("starter", process.env.CARTRIDGE_BIND_STARTER_ABI, {
          cartridgeId: "1",
          templateId: "dai",
          collateral: "0x0000000000000000000000000000000000000001",
        }),
      /unsupported bind ABI fragment/i,
    );
    const r = await runBindStarter({
      expectWallet: "0x" + "22".repeat(20),
      cartridgeId: "1",
      templateId: "dai",
      collateral: "0x0000000000000000000000000000000000000001",
      signTx: async () => {
        throw new Error("signTx must not be called");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "ABI_UNSUPPORTED");
  });
});

describe("hero mint readback", () => {
  it("pickNewHeroFromDiff prefers confirmed preferredId", async () => {
    const { pickNewHeroFromDiff, interpretBindResult } = await import(`${rbUrl}?t=${Date.now()}`);
    const p = pickNewHeroFromDiff({
      beforeIds: ["owned-1"],
      afterIds: ["owned-1", "owned-99"],
      preferredId: "owned-99",
      hintIncludes: "owned-99",
    });
    assert.equal(p.id, "owned-99");
    assert.equal(p.source, "confirmed");

    const starter = pickNewHeroFromDiff({
      beforeIds: [],
      afterIds: ["starter-dai-h1-2"],
      hintIncludes: "dai",
      preferredId: "starter-dai-h1-1",
    });
    assert.equal(starter.id, "starter-dai-h1-2");
    assert.equal(starter.source, "readback");

    const guess = pickNewHeroFromDiff({
      beforeIds: ["a"],
      afterIds: ["a"],
      preferredId: "starter-dai-h1-3",
      hintIncludes: "dai",
    });
    assert.equal(guess.id, "starter-dai-h1-3");
    assert.equal(guess.source, "guess");

    assert.equal(interpretBindResult({ ok: false, code: "ABI_MISSING", error: "x" }).code, "ABI_MISSING");
    assert.equal(interpretBindResult({ ok: true, txHash: "0x1" }).ok, true);
  });
});
