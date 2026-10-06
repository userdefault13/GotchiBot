/**
 * Launch updater: the newest release any source publishes wins.
 *   node --test tests/update-check-sources.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchCdnLatest } from "../scripts/update-check.mjs";

const urls = ["https://cdn.example/latest.json", "https://www.example/api/release-manifest", "https://raw.githubusercontent.com/x/y/main/config/latest.json"];

describe("fetchCdnLatest", () => {
  it("takes the highest version, not the first source that answers", async () => {
    const r = await fetchCdnLatest({
      urls,
      fetchManifest: async (u) => (u.includes("cdn") ? null : u.includes("www") ? { version: "0.2.1", notes: "stale site" } : { version: "0.3.2", notes: "github" }),
    });
    assert.equal(r.manifest.version, "0.3.2");
    assert.equal(r.source, "github");
  });

  it("keeps the earlier source on a tie and returns null when none answers", async () => {
    const tie = await fetchCdnLatest({ urls, fetchManifest: async () => ({ version: "0.3.2" }) });
    assert.equal(tie.source, "cdn");
    assert.equal(await fetchCdnLatest({ urls, fetchManifest: async () => null }), null);
  });
});
