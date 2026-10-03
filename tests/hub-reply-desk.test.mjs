/**
 * MacBook desk is queued for the hub runner; every other desk id is not.
 * Loads the allowlist predicate from store.mjs without Mongo.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const MACBOOK = "01M3ZTEW67RX4EJFE83YW5YP0H";
const src = readFileSync(
  new URL("../services/gotchibot-api/store.mjs", import.meta.url),
  "utf8",
);

function loadPredicate() {
  const constAt = src.indexOf("const HUB_REPLY_DESK_IDS");
  const fnAt = src.indexOf("/** Desk kind for access checks");
  const end = src.indexOf("export async function connectStore");
  assert.ok(constAt >= 0 && fnAt > constAt && end > fnAt, "allowlist predicate missing");
  const decl = src.slice(constAt, src.indexOf(";", constAt) + 1);
  const sandbox = {};
  vm.runInNewContext(
    `${decl}\n${src.slice(fnAt, end)}\nthis.api = { HUB_REPLY_DESK_IDS, deskQueuesHubReply, deskKindOf };`,
    sandbox,
  );
  return sandbox.api;
}

describe("MacBook desk hub-reply allowlist", () => {
  const { HUB_REPLY_DESK_IDS, deskQueuesHubReply, deskKindOf } = loadPredicate();

  it("allowlist is only the MacBook desk", () => {
    assert.deepEqual([...HUB_REPLY_DESK_IDS], [MACBOOK]);
  });

  it("queues that desk id and no other", () => {
    const mac = { deskId: MACBOOK, kind: "desk" };
    assert.equal(deskKindOf(mac), "desk");
    assert.equal(deskQueuesHubReply(mac), true);
    assert.equal(deskQueuesHubReply({ deskId: `  ${MACBOOK}  `, kind: "desk" }), true);
    assert.equal(deskQueuesHubReply({ deskId: "01OTHERDESK00000000000000", kind: "desk" }), false);
    assert.equal(deskQueuesHubReply({ deskId: "hub-runner", kind: "desk" }), false);
    assert.equal(deskQueuesHubReply({ kind: "desk" }), false);
    assert.equal(deskQueuesHubReply(null), false);
    assert.equal(deskQueuesHubReply({ deskId: MACBOOK, revoked: true }), false);
    // a flag on some other desk does not enqueue the fleet
    assert.equal(deskQueuesHubReply({ deskId: "01OTHERDESK00000000000000", hubReply: true }), false);
  });

  it("stamps a user message like a phone send, without phone write restrictions", () => {
    const stamp = src.slice(
      src.indexOf("} else if (queueHubReply"),
      src.indexOf("await chatMessages.insertOne(doc);"),
    );
    assert.match(stamp, /originKind = "phone"/);
    assert.match(stamp, /status: "pending"/);
    assert.doesNotMatch(stamp, /doc\.threadKind/);
    assert.match(src, /const queueHubReply = !isPhone && deskQueuesHubReply\(desk\)/);
    assert.match(src, /deskKindOf\(desk\) === "phone" \|\| queueHubReply \? "pending" : "none"/);
    assert.match(src, /if \(isPhone && op !== "message"\)/);
    assert.match(src, /if \(isPhone\) role = "user"/);
    assert.doesNotMatch(src, /queueHubReply && op !== "message"/);
  });
});
