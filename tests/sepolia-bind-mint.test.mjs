/**
 * Sepolia/mainnet bindOwned/bindStarter + readback + preflight.
 * All offline — mocked signer / readContract / getReceipt. No browser, no RPC.
 *   node --test tests/sepolia-bind-mint.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const mintUrl = pathToFileURL(join(root, "scripts", "cartridge-mint-sepolia.mjs")).href;
const rbUrl = pathToFileURL(join(root, "scripts", "hero-mint-readback.mjs")).href;
const gateUrl = pathToFileURL(join(root, "scripts", "hero-apply-gate.mjs")).href;

const sepoliaCfg = JSON.parse(
  readFileSync(join(root, "config/cartridgeChain.base-sepolia.json"), "utf8"),
);
const mainnetCfg = JSON.parse(
  readFileSync(join(root, "config/cartridgeChain.base.json"), "utf8"),
);

async function loadEthers() {
  try {
    const m = await import("ethers");
    return m.ethers || m.default || m;
  } catch {
    const p = pathToFileURL(
      resolve(root, "../AarcadeGh-t/node_modules/ethers/lib.esm/index.js"),
    ).href;
    const m = await import(p);
    return m.ethers || m.default || m;
  }
}

const bust = () => `t=${Date.now()}-${Math.random()}`;

describe("resolveBindPageTimeoutMs", () => {
  it("option > env > default; invalid values fall through", async () => {
    const { resolveBindPageTimeoutMs } = await import(`${mintUrl}?${bust()}`);
    const envKey = "GOTCHIBOT_BIND_PAGE_TIMEOUT_MS";

    assert.equal(
      resolveBindPageTimeoutMs({ pageTimeoutMs: 600_000 }, { [envKey]: "120000" }),
      600_000,
    );
    assert.equal(
      resolveBindPageTimeoutMs({ pageTimeoutMs: "900000" }, { [envKey]: "120000" }),
      900_000,
    );
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: "120000" }), 120_000);
    assert.equal(resolveBindPageTimeoutMs({ pageTimeoutMs: 0 }, { [envKey]: "180000" }), 180_000);
    assert.equal(resolveBindPageTimeoutMs({ pageTimeoutMs: -1 }, { [envKey]: "180000" }), 180_000);
    assert.equal(resolveBindPageTimeoutMs({ pageTimeoutMs: "abc" }, { [envKey]: "180000" }), 180_000);
    assert.equal(resolveBindPageTimeoutMs({ pageTimeoutMs: null }, { [envKey]: "180000" }), 180_000);
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: "0" }), 300_000);
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: "-1" }), 300_000);
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: "abc" }), 300_000);
    assert.equal(resolveBindPageTimeoutMs({}, {}), 300_000);
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: "" }), 300_000);
    assert.equal(resolveBindPageTimeoutMs({}, { [envKey]: undefined }), 300_000);
  });
});

describe("config JSON + selectors", () => {
  it("sepolia + mainnet configs parse and carry bind fragments", () => {
    assert.equal(sepoliaCfg.chainId, 84532);
    assert.equal(sepoliaCfg.starterBindFeeWei, "5000000000000000000");
    assert.equal(sepoliaCfg.bindSelectors.bindOwned, "0x75002762");
    assert.equal(sepoliaCfg.bindSelectors.bindStarter, "0x100cc61b");
    assert.equal(sepoliaCfg.events.topic0, "0x1827e5bd6f1d1f8b1db16accce3f4eaa3a7db62d925e97e9eb749276c400baa9");
    assert.ok(sepoliaCfg.l1AavegotchiDiamond.startsWith("0x"));
    assert.ok(sepoliaCfg.views.lineAPaid);
    assert.ok(sepoliaCfg.views.portalStatus);
    assert.ok(sepoliaCfg.views.ownerOf);
    assert.ok(sepoliaCfg.views.heroIds);
    assert.equal(mainnetCfg.chainId, 8453);
    assert.equal(mainnetCfg.signingEnabled, false);
    assert.equal(mainnetCfg.bindSelectors.bindStarter, "0x1b33e284");
    assert.equal(mainnetCfg.starterBindFee, "5000000");
    assert.equal(mainnetCfg.usdcToken.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.ok(mainnetCfg.views.lineAPaid);
  });

  it("calldata selectors match documented values", async () => {
    const ethers = await loadEthers();
    const { encodeBindCalldata, loadChainConfig } = await import(`${mintUrl}?${bust()}`);
    const cfg = loadChainConfig({ cfg: sepoliaCfg });
    const owned = await encodeBindCalldata("owned", cfg.bindAbi.bindOwned, {
      cartridgeId: "1",
      sourceTokenId: "954",
    }, ethers);
    assert.equal(owned.data.slice(0, 10).toLowerCase(), "0x75002762");

    const starter = await encodeBindCalldata("starter", cfg.bindAbi.bindStarter, {
      cartridgeId: "1",
      templateId: "dai",
      collateral: "0x" + "11".repeat(20),
    }, ethers);
    assert.equal(starter.data.slice(0, 10).toLowerCase(), "0x100cc61b");

    const mn = await encodeBindCalldata(
      "starter",
      mainnetCfg.bindAbi.bindStarter,
      {
        cartridgeId: "1",
        templateId: "dai",
        collateral: "0x" + "11".repeat(20),
        paymentToken: mainnetCfg.usdcToken,
        maxAmount: mainnetCfg.starterBindFee,
      },
      ethers,
    );
    assert.equal(mn.data.slice(0, 10).toLowerCase(), "0x1b33e284");

    assert.equal(ethers.id("heroIds(uint256)").slice(0, 10).toLowerCase(), "0x614a4e44");
    const topic = ethers.id("CAavegotchiBound(uint256,bytes32,uint8,uint256)");
    assert.equal(topic.toLowerCase(), sepoliaCfg.events.topic0.toLowerCase());
  });

  it("recomputes every selector from config fragments (ethers)", async () => {
    const ethers = await loadEthers();
    const sel = (frag) => {
      const iface = new ethers.Interface([frag]);
      return iface.getFunction(frag.name).selector.toLowerCase();
    };
    const expect = {
      bindOwned: "0x75002762",
      bindStarterSepolia: "0x100cc61b",
      bindStarterMainnet: "0x1b33e284",
      heroIds: "0x614a4e44",
      lineAPaid: "0x184014a2",
      portalStatus: "0xf97b606a",
      ownerOf: "0x6352211e",
    };
    assert.equal(sel(sepoliaCfg.bindAbi.bindOwned), expect.bindOwned);
    assert.equal(sel(sepoliaCfg.bindAbi.bindStarter), expect.bindStarterSepolia);
    assert.equal(sel(mainnetCfg.bindAbi.bindStarter), expect.bindStarterMainnet);
    assert.equal(sel(sepoliaCfg.views.heroIds), expect.heroIds);
    assert.equal(sel(sepoliaCfg.views.lineAPaid), expect.lineAPaid);
    assert.equal(sel(sepoliaCfg.views.portalStatus), expect.portalStatus);
    assert.equal(sel(sepoliaCfg.views.ownerOf), expect.ownerOf);
    assert.equal(sel(mainnetCfg.views.heroIds), expect.heroIds);
    assert.equal(sel(mainnetCfg.views.lineAPaid), expect.lineAPaid);
    assert.equal(sel(mainnetCfg.views.portalStatus), expect.portalStatus);
    assert.equal(sel(mainnetCfg.views.ownerOf), expect.ownerOf);

    assert.equal(sepoliaCfg.bindSelectors.bindOwned.toLowerCase(), expect.bindOwned);
    assert.equal(sepoliaCfg.bindSelectors.bindStarter.toLowerCase(), expect.bindStarterSepolia);
    assert.equal(mainnetCfg.bindSelectors.bindStarter.toLowerCase(), expect.bindStarterMainnet);
    assert.equal(sepoliaCfg.bindSelectors.heroIds.toLowerCase(), expect.heroIds);
    assert.equal(sepoliaCfg.bindSelectors.lineAPaid.toLowerCase(), expect.lineAPaid);
    assert.equal(sepoliaCfg.bindSelectors.portalStatus.toLowerCase(), expect.portalStatus);
    assert.equal(sepoliaCfg.bindSelectors.ownerOf.toLowerCase(), expect.ownerOf);
    assert.equal(mainnetCfg.bindSelectors.heroIds.toLowerCase(), expect.heroIds);
    assert.equal(mainnetCfg.bindSelectors.lineAPaid.toLowerCase(), expect.lineAPaid);
    assert.equal(mainnetCfg.bindSelectors.portalStatus.toLowerCase(), expect.portalStatus);
    assert.equal(mainnetCfg.bindSelectors.ownerOf.toLowerCase(), expect.ownerOf);

    const topic = ethers.id("CAavegotchiBound(uint256,bytes32,uint8,uint256)");
    assert.equal(
      topic.toLowerCase(),
      "0x1827e5bd6f1d1f8b1db16accce3f4eaa3a7db62d925e97e9eb749276c400baa9",
    );
    assert.equal(sepoliaCfg.events.topic0.toLowerCase(), topic.toLowerCase());
    assert.equal(mainnetCfg.events.topic0.toLowerCase(), topic.toLowerCase());
  });

  it("loadChainConfig accepts injected cfg (no AarcadeGh-t)", async () => {
    const { loadChainConfig, resolveBindAbi } = await import(`${mintUrl}?${bust()}`);
    const cfg = loadChainConfig({ cfg: { chainId: 84532, bindAbi: {} } });
    assert.equal(cfg.chainId, 84532);
    assert.equal(resolveBindAbi("owned", { cfg }), null);
  });
});

describe("templateId encoding (CoS-confirmed keccak256)", () => {
  const DAI_VEC =
    "0x9f08c71555a1be56230b2e2579fafe4777867e0a1b947f01073e934471de15c1";
  const WBTC_VEC =
    "0x59e50295208418569657dcdbf79b85731eff3be260696ead2b44b1c097916a6c";

  it("encodeTemplateId vectors: dai / DAI / wbtc / passthrough hex", async () => {
    const ethers = await loadEthers();
    const { encodeTemplateId } = await import(`${rbUrl}?${bust()}`);
    assert.equal(encodeTemplateId("dai", ethers).toLowerCase(), DAI_VEC);
    assert.equal(encodeTemplateId("DAI", ethers).toLowerCase(), DAI_VEC);
    assert.equal(encodeTemplateId("wbtc", ethers).toLowerCase(), WBTC_VEC);
    assert.equal(
      encodeTemplateId(DAI_VEC, ethers).toLowerCase(),
      DAI_VEC,
    );
    assert.equal(
      ethers.keccak256(ethers.toUtf8Bytes("dai")).toLowerCase(),
      DAI_VEC,
    );
  });

  it("starter deterministic id for dai n=3; matcher agrees; calldata carries dai vector", async () => {
    const ethers = await loadEthers();
    const {
      encodeTemplateId,
      starterHeroIdBytes32,
      resolveHeroIdAfterReceipt,
    } = await import(`${rbUrl}?${bust()}`);
    const { matchSepoliaHeroBytes32 } = await import(`${gateUrl}?${bust()}`);
    const { encodeBindCalldata, loadChainConfig } = await import(`${mintUrl}?${bust()}`);

    const tid = encodeTemplateId("dai", ethers);
    assert.equal(tid.toLowerCase(), DAI_VEC);
    const starterVec = starterHeroIdBytes32(tid, 3, ethers);
    const expected = ethers.solidityPackedKeccak256(
      ["string", "bytes32", "string", "uint256"],
      ["starter-", DAI_VEC, "-", 3n],
    );
    assert.equal(starterVec.toLowerCase(), expected.toLowerCase());

    assert.equal(
      matchSepoliaHeroBytes32(starterVec, "starter-dai-h1-1", ethers, {
        onchainHeroIds: {
          "starter-dai-h1-1": { heroIdBytes32: starterVec },
        },
      }),
      true,
    );

    const det = await resolveHeroIdAfterReceipt({
      receipt: { status: 1, logs: [] },
      cartridgeDiamond: sepoliaCfg.cartridgeDiamond,
      cartridgeId: "1",
      bindKind: "starter",
      templateId: "dai",
      heroIdsBefore: [1, 2, 3],
      readHeroIds: async () => [],
      ethersLib: ethers,
    });
    assert.equal(det.source, "deterministic");
    assert.equal(det.heroIdBytes32.toLowerCase(), starterVec.toLowerCase());

    const cfg = loadChainConfig({ cfg: sepoliaCfg });
    const coll = "0x" + "11".repeat(20);
    const encoded = await encodeBindCalldata(
      "starter",
      cfg.bindAbi.bindStarter,
      { cartridgeId: "1", templateId: "dai", collateral: coll },
      ethers,
    );
    const iface = new ethers.Interface([cfg.bindAbi.bindStarter]);
    const decoded = iface.decodeFunctionData("bindStarter", encoded.data);
    assert.equal(String(decoded[0]), "1");
    assert.equal(String(decoded[1]).toLowerCase(), DAI_VEC);
    assert.equal(String(decoded[2]).toLowerCase(), coll.toLowerCase());
    assert.equal(encoded.templateIdBytes32.toLowerCase(), DAI_VEC);
  });
});

describe("ABI_MISSING / MAINNET_DISABLED / Sepolia value", () => {
  it("injected empty cfg → ABI_MISSING (signer never called)", async () => {
    const { runBindOwned, runBindStarter } = await import(`${mintUrl}?${bust()}`);
    const empty = { chainId: 84532, cartridgeDiamond: "0x" + "bb".repeat(20), bindAbi: {} };
    let called = false;
    const signTx = async () => {
      called = true;
      return { ok: true, txHash: "0x1" };
    };
    const o = await runBindOwned({
      cfg: empty,
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      sourceTokenId: "2",
      signTx,
      printCost: false,
    });
    assert.equal(o.code, "ABI_MISSING");
    assert.equal(called, false);

    const s = await runBindStarter({
      cfg: empty,
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      templateId: "dai",
      collateral: "0x" + "22".repeat(20),
      signTx,
      printCost: false,
    });
    assert.equal(s.code, "ABI_MISSING");
    assert.equal(called, false);
  });

  it("Sepolia runBindStarter passes value = 5e18 wei; bindOwned value 0", async () => {
    const { runBindOwned, runBindStarter } = await import(`${mintUrl}?${bust()}`);
    let seenStarter = null;
    let seenOwned = null;
    const wallet = "0x" + "ab".repeat(20);
    const rS = await runBindStarter({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "7",
      templateId: "dai",
      collateral: "0x" + "cd".repeat(20),
      printCost: false,
      signTx: async (plan) => {
        seenStarter = plan;
        return { ok: true, txHash: "0xbeef" };
      },
    });
    assert.equal(rS.ok, true);
    assert.equal(seenStarter.chainId, 84532);
    assert.equal(String(seenStarter.to).toLowerCase(), sepoliaCfg.cartridgeDiamond.toLowerCase());
    assert.equal(seenStarter.value, 5000000000000000000n);
    assert.equal(seenStarter.data.slice(0, 10).toLowerCase(), "0x100cc61b");

    const rO = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "7",
      sourceTokenId: "954",
      printCost: false,
      signTx: async (plan) => {
        seenOwned = plan;
        return { ok: true, txHash: "0xdead" };
      },
    });
    assert.equal(rO.ok, true);
    assert.equal(seenOwned.value, 0n);
    assert.equal(seenOwned.data.slice(0, 10).toLowerCase(), "0x75002762");
  });

  it("mainnet runBindOwned/runBindStarter → MAINNET_DISABLED, signer never called", async () => {
    const { runBindOwned, runBindStarter, buildMainnetStarterPlan } = await import(
      `${mintUrl}?${bust()}`
    );
    let called = false;
    const signTx = async () => {
      called = true;
      return { ok: true };
    };
    const o = await runBindOwned({
      cfg: mainnetCfg,
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      sourceTokenId: "2",
      signTx,
    });
    assert.equal(o.code, "MAINNET_DISABLED");
    assert.equal(called, false);

    const s = await runBindStarter({
      cfg: mainnetCfg,
      expectWallet: "0x" + "11".repeat(20),
      cartridgeId: "1",
      templateId: "dai",
      collateral: "0x" + "22".repeat(20),
      signTx,
    });
    assert.equal(s.code, "MAINNET_DISABLED");
    assert.equal(called, false);

    const ethers = await loadEthers();
    const plan = await buildMainnetStarterPlan(
      {
        cartridgeId: "1",
        templateId: "dai",
        collateral: "0x" + "33".repeat(20),
        cfg: mainnetCfg,
      },
      ethers,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.txs.length, 2);
    assert.equal(String(plan.txs[0].to).toLowerCase(), mainnetCfg.usdcToken.toLowerCase());
    assert.match(plan.txs[0].data.slice(0, 10).toLowerCase(), /^0x095ea7b3$/); // approve
    // spender = diamond, amount = fee — decode via Interface
    const approveIface = new ethers.Interface([
      "function approve(address spender, uint256 amount) returns (bool)",
    ]);
    const decoded = approveIface.decodeFunctionData("approve", plan.txs[0].data);
    assert.equal(String(decoded[0]).toLowerCase(), mainnetCfg.cartridgeDiamond.toLowerCase());
    assert.equal(decoded[1], 5000000n);
    assert.equal(String(plan.txs[1].to).toLowerCase(), mainnetCfg.cartridgeDiamond.toLowerCase());
    assert.equal(plan.txs[1].data.slice(0, 10).toLowerCase(), "0x1b33e284");
    assert.equal(String(plan.txs[1].paymentToken).toLowerCase(), mainnetCfg.usdcToken.toLowerCase());
    assert.ok(plan.txs[1].maxAmount >= 5000000n);
    assert.match(plan.note, /allowance check then approve/i);
  });
});

describe("preflight", () => {
  const wallet = "0x" + "aa".repeat(20);
  const other = "0x" + "bb".repeat(20);
  const diamond = sepoliaCfg.cartridgeDiamond;
  const l1 = sepoliaCfg.l1AavegotchiDiamond;

  function mockRead(overrides = {}) {
    return async ({ address, functionName }) => {
      const key = `${String(address).toLowerCase()}:${functionName}`;
      if (overrides[key] !== undefined) {
        if (overrides[key] instanceof Error) throw overrides[key];
        return overrides[key];
      }
      if (functionName === "ownerOf" && String(address).toLowerCase() === diamond.toLowerCase()) {
        return wallet;
      }
      if (functionName === "portalStatus") return 0;
      if (functionName === "lineAPaid") return true;
      if (functionName === "heroIds") return [];
      if (functionName === "ownerOf" && String(address).toLowerCase() === l1.toLowerCase()) {
        return wallet;
      }
      throw new Error(`unexpected read ${key}`);
    };
  }

  it("not owner → PREFLIGHT, signer not called", async () => {
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);
    let called = false;
    const r = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${diamond.toLowerCase()}:ownerOf`]: other,
      }),
      signTx: async () => {
        called = true;
        return { ok: true };
      },
      printCost: false,
      printPreflight: false,
    });
    assert.equal(r.code, "PREFLIGHT");
    assert.equal(called, false);
    assert.ok(r.checks.some((c) => c.name === "ownerOf" && c.status === "failed"));
  });

  it("portalStatus: 0 LEGACY and 2 OPEN pass; 1 SEALED → PREFLIGHT", async () => {
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);

    for (const status of [0, 2]) {
      let called = false;
      const r = await runBindOwned({
        cfg: sepoliaCfg,
        expectWallet: wallet,
        cartridgeId: "1",
        sourceTokenId: "9",
        readContract: mockRead({
          [`${diamond.toLowerCase()}:portalStatus`]: status,
        }),
        signTx: async () => {
          called = true;
          return { ok: true, txHash: "0xok" };
        },
        printCost: false,
        printPreflight: false,
      });
      assert.equal(r.ok, true, `portalStatus=${status} should pass`);
      assert.equal(called, true);
    }

    let sealedCalled = false;
    const sealed = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "42",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${diamond.toLowerCase()}:portalStatus`]: 1,
      }),
      signTx: async () => {
        sealedCalled = true;
        return { ok: true };
      },
      printCost: false,
      printPreflight: false,
    });
    assert.equal(sealed.code, "PREFLIGHT");
    assert.equal(sealedCalled, false);
    assert.match(sealed.error, /SEALED/i);
    assert.match(sealed.error, /GotchiBotNestFacet open/i);
  });

  it("lineAPaid false → PREFLIGHT, signer not called; true → passes", async () => {
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);
    let called = false;
    const unpaid = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${diamond.toLowerCase()}:lineAPaid`]: false,
      }),
      signTx: async () => {
        called = true;
        return { ok: true };
      },
      printCost: false,
      printPreflight: false,
    });
    assert.equal(unpaid.code, "PREFLIGHT");
    assert.equal(called, false);
    assert.match(unpaid.error, /LINE_A_UNPAID/);
    assert.ok(unpaid.checks.some((c) => c.name === "lineAPaid" && c.status === "failed"));

    let paidCalled = false;
    const paid = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${diamond.toLowerCase()}:lineAPaid`]: true,
      }),
      signTx: async () => {
        paidCalled = true;
        return { ok: true, txHash: "0xpaid" };
      },
      printCost: false,
      printPreflight: false,
    });
    assert.equal(paid.ok, true);
    assert.equal(paidCalled, true);
  });

  it("lineAPaid read error → PREFLIGHT", async () => {
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);
    let called = false;
    const r = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${diamond.toLowerCase()}:lineAPaid`]: new Error("rpc down"),
      }),
      signTx: async () => {
        called = true;
        return { ok: true };
      },
      printCost: false,
      printPreflight: false,
    });
    assert.equal(r.code, "PREFLIGHT");
    assert.equal(called, false);
    assert.match(r.error, /lineAPaid failed/i);
  });

  it("L1 owner mismatch → PREFLIGHT", async () => {
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);
    const r = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      readContract: mockRead({
        [`${l1.toLowerCase()}:ownerOf`]: other,
      }),
      signTx: async () => ({ ok: true }),
      printCost: false,
      printPreflight: false,
    });
    assert.equal(r.code, "PREFLIGHT");
    assert.match(r.error, /L1/i);
  });

  it("already bound → PREFLIGHT; lineAPaid enforced (passed before alreadyBound)", async () => {
    const ethers = await loadEthers();
    const { runBindOwned } = await import(`${mintUrl}?${bust()}`);
    const { ownedHeroIdBytes32 } = await import(`${rbUrl}?${bust()}`);
    const hid = ownedHeroIdBytes32(9, ethers);
    const r = await runBindOwned({
      cfg: sepoliaCfg,
      expectWallet: wallet,
      cartridgeId: "1",
      sourceTokenId: "9",
      ethersLib: ethers,
      readContract: mockRead({
        [`${diamond.toLowerCase()}:heroIds`]: [hid],
      }),
      signTx: async () => ({ ok: true }),
      printCost: false,
      printPreflight: false,
    });
    assert.equal(r.code, "PREFLIGHT");
    assert.match(r.error, /already bound/i);
    assert.ok(r.checks.some((c) => c.name === "lineAPaid" && c.status === "passed"));
  });
});

describe("receipt readback + deterministic + matcher", () => {
  it("event log → heroId topics[2]; status 0 → TX_REVERTED; timeout → RECEIPT_TIMEOUT", async () => {
    const ethers = await loadEthers();
    const {
      waitForBindReceipt,
      parseCAavegotchiBoundLog,
      readbackAfterBind,
      recordOnchainHeroId,
      loadOnchainHeroIds,
      CAVEGOTCHI_BOUND_TOPIC0,
    } = await import(`${rbUrl}?${bust()}`);

    const frag = sepoliaCfg.events.CAavegotchiBound;
    const heroBytes = ethers.solidityPackedKeccak256(["string", "uint256"], ["owned-", 954n]);
    const topic0 = ethers.id("CAavegotchiBound(uint256,bytes32,uint8,uint256)");
    const topic1 = ethers.zeroPadValue(ethers.toBeHex(1n), 32);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint256"], [1, 954n]);
    const diamond = sepoliaCfg.cartridgeDiamond;
    const receiptOk = {
      status: 1,
      logs: [
        {
          address: diamond,
          topics: [topic0, topic1, heroBytes],
          data,
        },
      ],
    };
    const parsed = parseCAavegotchiBoundLog(receiptOk, {
      cartridgeDiamond: diamond,
      topic0: CAVEGOTCHI_BOUND_TOPIC0,
      ethersLib: ethers,
      eventFragment: frag,
    });
    assert.equal(String(parsed.heroIdBytes32).toLowerCase(), heroBytes.toLowerCase());
    assert.equal(parsed.bindType, 1);

    const reverted = await waitForBindReceipt("0xaaa", {
      getReceipt: async () => ({ status: 0, logs: [] }),
      intervalMs: 1,
      timeoutMs: 50,
    });
    assert.equal(reverted.code, "TX_REVERTED");

    const timed = await waitForBindReceipt("0xbbb", {
      getReceipt: async () => null,
      intervalMs: 5,
      timeoutMs: 20,
    });
    assert.equal(timed.code, "RECEIPT_TIMEOUT");

    const store = {};
    const rbFail = await readbackAfterBind({
      txHash: "0xccc",
      getReceipt: async () => ({ status: 0 }),
      record: true,
      deskId: "owned-1",
      writeFile: (p, body) => {
        store[p] = body;
      },
      readFile: (p) => store[p] || "{}",
      onchainPath: "/tmp/test-onchain-heroes.json",
    });
    assert.equal(rbFail.code, "TX_REVERTED");
    assert.equal(Object.keys(store).length, 0);

    const rbOk = await readbackAfterBind({
      txHash: "0xddd",
      getReceipt: async () => receiptOk,
      cartridgeDiamond: diamond,
      topic0: CAVEGOTCHI_BOUND_TOPIC0,
      eventFragment: frag,
      ethersLib: ethers,
      bindKind: "owned",
      sourceTokenId: "954",
      deskId: "owned-954",
      chainId: 84532,
      onchainPath: "/tmp/test-onchain-heroes2.json",
      writeFile: (p, body) => {
        store[p] = body;
      },
      readFile: (p) => store[p] || "{}",
    });
    assert.equal(rbOk.ok, true);
    assert.equal(rbOk.source, "event");
    assert.ok(store["/tmp/test-onchain-heroes2.json"]);
  });

  it("fallback: no log → last heroIds; no heroIds → deterministic; matcher agrees", async () => {
    const ethers = await loadEthers();
    const {
      resolveHeroIdAfterReceipt,
      ownedHeroIdBytes32,
      starterHeroIdBytes32,
      encodeTemplateId,
    } = await import(`${rbUrl}?${bust()}`);
    const { matchSepoliaHeroBytes32 } = await import(`${gateUrl}?${bust()}`);

    const ownedVec = ownedHeroIdBytes32(954, ethers);
    const expectedOwned = ethers.solidityPackedKeccak256(["string", "uint256"], ["owned-", 954n]);
    assert.equal(ownedVec.toLowerCase(), expectedOwned.toLowerCase());
    assert.equal(matchSepoliaHeroBytes32(ownedVec, "owned-954", ethers), true);

    const tid = encodeTemplateId("dai", ethers);
    const starterVec = starterHeroIdBytes32(tid, 3, ethers);
    const expectedStarter = ethers.solidityPackedKeccak256(
      ["string", "bytes32", "string", "uint256"],
      ["starter-", tid, "-", 3n],
    );
    assert.equal(starterVec.toLowerCase(), expectedStarter.toLowerCase());

    const lastId = "0x" + "ee".repeat(32);
    const fromList = await resolveHeroIdAfterReceipt({
      receipt: { status: 1, logs: [] },
      cartridgeDiamond: sepoliaCfg.cartridgeDiamond,
      cartridgeId: "1",
      bindKind: "owned",
      sourceTokenId: "1",
      readHeroIds: async () => ["0x" + "11".repeat(32), lastId],
      ethersLib: ethers,
    });
    assert.equal(fromList.source, "heroIds");
    assert.equal(fromList.heroIdBytes32, lastId);

    const det = await resolveHeroIdAfterReceipt({
      receipt: { status: 1, logs: [] },
      cartridgeDiamond: sepoliaCfg.cartridgeDiamond,
      cartridgeId: "1",
      bindKind: "owned",
      sourceTokenId: "954",
      readHeroIds: async () => [],
      ethersLib: ethers,
    });
    assert.equal(det.source, "deterministic");
    assert.equal(det.heroIdBytes32.toLowerCase(), ownedVec.toLowerCase());

    const detS = await resolveHeroIdAfterReceipt({
      receipt: { status: 1, logs: [] },
      cartridgeDiamond: sepoliaCfg.cartridgeDiamond,
      cartridgeId: "1",
      bindKind: "starter",
      templateId: "dai",
      heroIdsBefore: [1, 2, 3], // length 3 → n=3
      readHeroIds: async () => [],
      ethersLib: ethers,
    });
    assert.equal(detS.source, "deterministic");
    assert.equal(detS.heroIdBytes32.toLowerCase(), starterVec.toLowerCase());

    assert.equal(
      matchSepoliaHeroBytes32(starterVec, "starter-dai-h1-1", ethers, {
        onchainHeroIds: {
          "starter-dai-h1-1": { heroIdBytes32: starterVec },
        },
      }),
      true,
    );
  });
});

describe("hero mint readback (desk diff)", () => {
  it("pickNewHeroFromDiff prefers confirmed preferredId", async () => {
    const { pickNewHeroFromDiff, interpretBindResult } = await import(`${rbUrl}?${bust()}`);
    const p = pickNewHeroFromDiff({
      beforeIds: ["owned-1"],
      afterIds: ["owned-1", "owned-99"],
      preferredId: "owned-99",
      hintIncludes: "owned-99",
    });
    assert.equal(p.id, "owned-99");
    assert.equal(p.source, "confirmed");

    assert.equal(interpretBindResult({ ok: false, code: "ABI_MISSING", error: "x" }).code, "ABI_MISSING");
    assert.equal(interpretBindResult({ ok: true, txHash: "0x1" }).ok, true);
    assert.equal(
      interpretBindResult({ ok: false, code: "RECEIPT_TIMEOUT", txHash: "0x2", error: "t" }).txHash,
      "0x2",
    );
  });
});

describe("Sepolia desk id (deterministic, not bytes32 diff)", () => {
  it("nextStarterDeskLabel: max k+1, ignore bytes32/noise, different haunt ignored", async () => {
    const { nextStarterDeskLabel } = await import(`${rbUrl}?${bust()}`);
    const bytes32 = "0x" + "ab".repeat(32);
    assert.equal(
      nextStarterDeskLabel("dai", 1, [
        "starter-dai-h1-1",
        "starter-dai-h1-2",
        "starter-dai-h1-3",
        bytes32,
        "starter-link-h1-9",
        "owned-954",
      ]),
      "starter-dai-h1-4",
    );
    assert.equal(nextStarterDeskLabel("dai", 1, [bytes32, "owned-1"]), "starter-dai-h1-1");
    assert.equal(
      nextStarterDeskLabel("dai", 1, ["starter-dai-h2-5", "starter-dai-h1-2"]),
      "starter-dai-h1-3",
    );
  });

  it("deskIdForBind owned formula mismatch warns; starter uses nextStarterDeskLabel", async () => {
    const ethers = await loadEthers();
    const { deskIdForBind, ownedHeroIdBytes32 } = await import(`${rbUrl}?${bust()}`);
    const ok = deskIdForBind({
      kind: "owned",
      tokenId: "954",
      heroIdBytes32: ownedHeroIdBytes32(954, ethers),
      ethersLib: ethers,
    });
    assert.equal(ok.deskId, "owned-954");
    assert.equal(ok.warning, null);

    const badBytes = "0x" + "cd".repeat(32);
    const mismatch = deskIdForBind({
      kind: "owned",
      tokenId: "954",
      heroIdBytes32: badBytes,
      ethersLib: ethers,
    });
    assert.equal(mismatch.deskId, "owned-954");
    assert.ok(mismatch.warning);
    assert.match(mismatch.warning, /mismatch/i);
    assert.ok(mismatch.warning.includes(badBytes));

    const starter = deskIdForBind({
      kind: "starter",
      collateralId: "dai",
      hauntId: 1,
      knownIds: ["starter-dai-h1-1", "starter-dai-h1-2"],
    });
    assert.equal(starter.deskId, "starter-dai-h1-3");
    assert.equal(starter.warning, null);
  });

  it("recordOnchainHeroId keyed by final desk id (injected read/write)", async () => {
    const { recordOnchainHeroId, loadOnchainHeroIds, collectKnownDeskIds } = await import(
      `${rbUrl}?${bust()}`
    );
    const store = {};
    const path = "/tmp/test-final-desk-onchain.json";
    const rec = recordOnchainHeroId(
      "starter-dai-h1-4",
      {
        heroIdBytes32: "0x" + "ef".repeat(32),
        chainId: 84532,
        txHash: "0xabc",
        bindType: 3,
        source: "event",
        sourceTokenId: null,
      },
      {
        path,
        writeFile: (p, body) => {
          store[p] = body;
        },
        readFile: (p) => store[p] || "{}",
      },
    );
    assert.equal(rec.heroIdBytes32, "0x" + "ef".repeat(32));
    const map = loadOnchainHeroIds({
      path,
      readFile: (p) => store[p] || "{}",
    });
    assert.ok(map["starter-dai-h1-4"]);
    assert.equal(map["starter-dai-h1-4"].txHash, "0xabc");
    assert.equal(Object.keys(map).includes("0x" + "ef".repeat(32)), false);

    const known = collectKnownDeskIds({
      onchainHeroIds: map,
      nestIds: ["0x" + "11".repeat(32), "owned-1", "starter-dai-h1-1"],
      heroAgentState: { "starter-dai-h1-2": { status: "idle" } },
      workspaceNames: ["starter-dai-h1-3", "owned-954"],
    });
    assert.ok(known.includes("starter-dai-h1-4"));
    assert.ok(known.includes("starter-dai-h1-1"));
    assert.ok(known.includes("starter-dai-h1-2"));
    assert.ok(known.includes("starter-dai-h1-3"));
    assert.ok(known.includes("owned-1"));
    assert.equal(known.includes("0x" + "11".repeat(32)), false);
  });
});
