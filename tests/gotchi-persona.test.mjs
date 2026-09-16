/**
 * Gotchi persona — trait voice bands, dead zone, kinship, cascade.
 *   node --test tests/gotchi-persona.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  W,
  intensity,
  pickTraits,
  kinshipClause,
  stageWord,
  fallbackLine,
  buildPersonaLine,
} from "../scripts/gotchi-persona.mjs";

describe("intensity bands", () => {
  it("slightly for |v-50| <= 10", () => {
    assert.equal(intensity(50), "slightly");
    assert.equal(intensity(60), "slightly");
    assert.equal(intensity(40), "slightly");
  });

  it("fairly for |v-50| <= 25", () => {
    assert.equal(intensity(61), "fairly");
    assert.equal(intensity(75), "fairly");
    assert.equal(intensity(25), "fairly");
  });

  it("very for |v-50| <= 40", () => {
    assert.equal(intensity(76), "very");
    assert.equal(intensity(90), "very");
    assert.equal(intensity(10), "very");
  });

  it("extremely beyond 40", () => {
    assert.equal(intensity(91), "extremely");
    assert.equal(intensity(0), "extremely");
    assert.equal(intensity(100), "extremely");
  });
});

describe("dead zone at 50", () => {
  it("all-50 traits produce an even-keeled spirit, not a high-trait read", () => {
    const line = buildPersonaLine({ name: "DAI", traits: [50, 50, 50, 50, 50, 50] });
    assert.equal(line, "DAI is an even-keeled spirit.");
  });

  it("a value just outside the dead zone still colors the voice", () => {
    const line = buildPersonaLine({ name: "Gotchi", modifiedTraits: [40, 58, 44, 50], kinship: 2546 });
    // NRG 40 slightly mellow · AGG 58 slightly fierce · SPK 44 slightly warm · BRN 50 dead zone
    assert.equal(
      line,
      "Gotchi is a slightly mellow, slightly fierce and slightly warm spirit — devoted to Julius (Spirit Bond 2546).",
    );
  });
});

describe("kinship clause", () => {
  it("omits the clause when kinship is missing or 0", () => {
    assert.equal(kinshipClause(undefined), "");
    assert.equal(kinshipClause(0), "");
    assert.equal(kinshipClause(null), "");
    assert.match(buildPersonaLine({ name: "DAI", traits: [50, 50, 50, 50] }), /^DAI is an even-keeled spirit\.$/);
  });

  it("devoted at >= 1000, fond at >= 100, warming up below", () => {
    assert.match(kinshipClause(1000), /devoted to Julius \(Spirit Bond 1000\)/);
    assert.match(kinshipClause(2546), /devoted to Julius \(Spirit Bond 2546\)/);
    assert.match(kinshipClause(100), /fond of Julius \(Spirit Bond 100\)/);
    assert.match(kinshipClause(999), /fond of Julius \(Spirit Bond 999\)/);
    assert.match(kinshipClause(50), /warming up to Julius \(Spirit Bond 50\)/);
    assert.match(kinshipClause(1), /warming up to Julius \(Spirit Bond 1\)/);
  });
});

describe("trait cascade", () => {
  it("prefers withSetsNumericTraits over modifiedTraits over traits over numericTraits", () => {
    const hero = {
      name: "Cascade",
      withSetsNumericTraits: [10, 10, 10, 10],
      modifiedTraits: [40, 58, 44, 50],
      traits: [50, 50, 50, 50],
      numericTraits: [90, 90, 90, 90],
    };
    assert.deepEqual(pickTraits(hero), [10, 10, 10, 10]);
    assert.equal(
      buildPersonaLine(hero),
      "Cascade is a very mellow, very gentle, very warm and very scrappy spirit.",
    );
  });

  it("skips an empty higher-priority array", () => {
    const hero = { name: "Skip", withSetsNumericTraits: [], modifiedTraits: [60, 60, 60, 60] };
    assert.deepEqual(pickTraits(hero), [60, 60, 60, 60]);
  });

  it("falls back to traits when modifiedTraits is absent", () => {
    assert.deepEqual(pickTraits({ traits: [37, 58, 43, 50] }), [37, 58, 43, 50]);
    assert.deepEqual(pickTraits({ numericTraits: [83, 85, 0, 15] }), [83, 85, 0, 15]);
  });

  it("drops non-numeric entries", () => {
    assert.deepEqual(pickTraits({ traits: ["40", null, "x", 50] }), [40, 50]);
  });
});

describe("fallback", () => {
  it("one line when traits are missing entirely", () => {
    assert.equal(
      buildPersonaLine({ name: "Ghost" }),
      "You are Ghost, an Aavegotchi. Let your Spirit Bond with Julius colour every reply.",
    );
    assert.equal(fallbackLine("Ghost"), buildPersonaLine({ name: "Ghost" }));
  });

  it("defaults the name to Gotchi", () => {
    assert.match(buildPersonaLine({}), /^You are Gotchi, an Aavegotchi\./);
  });
});

describe("stage", () => {
  it("omits stage when there is no usable createdAt/mintedAt", () => {
    assert.equal(stageWord({}), null);
    assert.equal(stageWord({ createdAt: "not-a-date" }), null);
    assert.equal(stageWord({ mintedAt: 12345 }), null);
  });

  it("derives an age adjective from a real timestamp", () => {
    const now = Date.now();
    assert.equal(stageWord({ createdAt: new Date(now - 10 * 86_400_000).toISOString() }), "young");
    assert.equal(stageWord({ mintedAt: new Date(now - 400 * 86_400_000).toISOString() }), "seasoned");
    assert.equal(stageWord({ createdAt: new Date(now - 3 * 365 * 86_400_000).toISOString() }), "ancient");
  });
});

describe("word table sanity", () => {
  it("covers the four persona axes with two words per direction", () => {
    assert.deepEqual(Object.keys(W), ["NRG", "AGG", "SPK", "BRN"]);
    for (const pair of Object.values(W)) {
      assert.equal(pair.length, 2);
      for (const words of pair) assert.equal(words.length, 2);
    }
  });
});