/**
 * Link a phone: QR + code from any paired desk.
 *   node --test tests/hub-phone-link.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main, phoneLinkOutput } from "../scripts/hub-phone-link.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("hub phone link", () => {
  it("builds the app deep link, a QR, and the code", () => {
    const out = phoneLinkOutput({
      code: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      appUrl: null,
      host: "hub.tail.ts.net",
    });
    assert.equal(out.link, "https://hub.tail.ts.net/app/#pair=ABCD-EFGH");
    assert.match(out.text, /code {5}ABCD-EFGH/);
    assert.match(out.text, /Pair → Scan QR/);
    assert.match(out.text, /[▀▄█]/, "has a QR");
  });

  it("asks the Hub API from a paired desk and fails clearly when unpaired", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gb-phone-"));
    const logs = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (s) => logs.push(String(s));
    console.error = (s) => logs.push(String(s));
    try {
      assert.equal(await main([], { root: dir }), 1);
      assert.match(logs.join("\n"), /not paired with a Hub/);
      mkdirSync(path.join(dir, "sessions"), { recursive: true });
      writeFileSync(path.join(dir, "sessions", ".hub.json"), JSON.stringify({ deskToken: "gbd_x", tailscaleHost: "hub.tail.ts.net" }));
      const seen = [];
      const request = async (method, p, opts) => {
        seen.push([method, p, opts.body]);
        return { ok: true, code: "WXYZ-1234", expiresAt: new Date(Date.now() + 600000).toISOString(), appUrl: "https://hub.tail.ts.net/app/" };
      };
      assert.equal(await main(["--name", "Pixel"], { root: dir, request }), 0);
      assert.deepEqual(seen[0], ["POST", "/api/gotchibot/hub/pair/phone", { name: "Pixel" }]);
      assert.match(logs.join("\n"), /\/app\/#pair=WXYZ-1234/);
    } finally {
      console.log = orig;
      console.error = origErr;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the Hub API lets desks, not phones, mint phone codes", () => {
    const src = readFileSync(path.join(root, "services/gotchibot-api/server.mjs"), "utf8");
    const route = src.slice(src.indexOf('path === "/api/gotchibot/hub/pair/phone"'));
    assert.match(route.slice(0, 600), /deskKind !== "desk"[\s\S]*403/);
    assert.match(route.slice(0, 800), /mintPairingCode\(\{ name, kind: "phone" \}\)/);
  });
});
