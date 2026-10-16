import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_PROXY_URL, localProbeLines, proxyKeyFromEnv, proxyKeyStdin,
} from "../scripts/remote-tunnel-restart.mjs";

describe("remote-tunnel-restart local probe", () => {
  it("targets graphql-proxy :8786, not the empty :8787", () => {
    assert.match(LOCAL_PROXY_URL, /^http:\/\/127\.0\.0\.1:8786\//);
    const s = localProbeLines(true).join("\n");
    assert.ok(!s.includes(":8787"));
    assert.match(s, /-H @-/);
  });
  it("never puts the key in the remote script; sends it as a header on stdin", () => {
    const key = "sekrit-test-value";
    assert.ok(!localProbeLines(true).join("\n").includes(key));
    assert.equal(proxyKeyStdin(key), `X-Subgraph-Proxy-Key: ${key}\n`);
    assert.equal(proxyKeyStdin(""), "");
    assert.ok(!localProbeLines(false).join("\n").includes("@-"));
  });
  it("reads the key from abra env names", () => {
    assert.equal(proxyKeyFromEnv({ GOTCHIBOT_SUBGRAPH_PROXY_KEY: " a " }), "a");
    assert.equal(proxyKeyFromEnv({ SUBGRAPH_PROXY_SECRET: "b" }), "b");
    assert.equal(proxyKeyFromEnv({}), "");
  });
});
