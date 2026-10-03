/**
 * Shared QEMU guest: one guest stays up between jobs. No QEMU, no /dev/kvm.
 *   node --test tests/gotchibot-vm-shared-guest.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHARED_GUEST_ID,
  planGuestUp,
  holderIsLive,
  jobEndAction,
  rmStopsGuest,
} from "../scripts/gotchibot-vm.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vmSrc = readFileSync(resolve(root, "scripts/gotchibot-vm.mjs"), "utf8");
const dispatchSrc = readFileSync(resolve(root, "scripts/opencode-dispatch.sh"), "utf8");

describe("planGuestUp", () => {
  it("boots the one shared guest when nothing is running", () => {
    assert.deepEqual(
      planGuestUp({ sessionId: "s1", sharedRunning: false, selfRunning: false }),
      { action: "boot" },
    );
  });

  it("attaches a later session to the live guest instead of booting", () => {
    assert.deepEqual(
      planGuestUp({ sessionId: "s2", sharedRunning: true, selfRunning: false, holder: null, holderAlive: false }),
      { action: "attach" },
    );
  });

  it("reattaches the session that already holds the guest", () => {
    assert.deepEqual(
      planGuestUp({
        sessionId: "s1",
        sharedRunning: true,
        selfRunning: false,
        holder: "s1",
        holderAlive: true,
      }),
      { action: "attach" },
    );
  });

  it("refuses a second job while the holder is still alive (one guest, not a pool)", () => {
    assert.deepEqual(
      planGuestUp({
        sessionId: "s2",
        sharedRunning: true,
        selfRunning: false,
        holder: "s1",
        holderAlive: true,
      }),
      { action: "busy", holder: "s1" },
    );
  });

  it("lets the next bot attach when the previous holder is stale", () => {
    assert.deepEqual(
      planGuestUp({
        sessionId: "s2",
        sharedRunning: true,
        selfRunning: false,
        holder: "s1",
        holderAlive: false,
      }),
      { action: "attach" },
    );
  });

  it("reuses an already-running shared guest when asked for that id", () => {
    assert.deepEqual(
      planGuestUp({ sessionId: SHARED_GUEST_ID, sharedRunning: true, selfRunning: false }),
      { action: "reuse" },
    );
  });

  it("reuses a legacy per-session qemu instead of starting another", () => {
    assert.deepEqual(
      planGuestUp({ sessionId: "demo", sharedRunning: false, selfRunning: true }),
      { action: "reuse" },
    );
  });
});

describe("holderIsLive", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");

  it("a live supervisor pid holds the guest", () => {
    assert.equal(holderIsLive({ status: "running", pidAlive: true, pidKnown: true, now }), true);
  });

  it("a dead pid is stale even if status is still running", () => {
    assert.equal(holderIsLive({ status: "running", pidAlive: false, pidKnown: true, now }), false);
  });

  it("status=running with no pid file yet counts as live inside the grace window", () => {
    assert.equal(
      holderIsLive({ status: "running", pidAlive: false, pidKnown: false, startedAt: "2026-10-02T11:55:00Z", now }),
      true,
    );
  });

  it("status=running with no pid file is stale after the grace window", () => {
    assert.equal(
      holderIsLive({ status: "running", pidAlive: false, pidKnown: false, startedAt: "2026-10-02T11:00:00Z", now }),
      false,
    );
  });

  it("a finished session does not hold the guest", () => {
    assert.equal(holderIsLive({ status: "done", pidAlive: false, pidKnown: false, now }), false);
  });
});

describe("job end and operator stop", () => {
  it("a VM job detaches and a Docker job still removes its container", () => {
    assert.equal(jobEndAction("vm"), "detach");
    assert.equal(jobEndAction("docker"), "rm");
    assert.equal(jobEndAction(undefined), "rm");
  });

  it("rm stops the shared guest and a legacy qemu, not a session that only attached", () => {
    assert.equal(rmStopsGuest({ id: SHARED_GUEST_ID, ownsQemu: true, attachedToShared: false }), true);
    assert.equal(rmStopsGuest({ id: SHARED_GUEST_ID, ownsQemu: false, attachedToShared: false }), true);
    assert.equal(rmStopsGuest({ id: "demo", ownsQemu: true, attachedToShared: false }), true);
    assert.equal(rmStopsGuest({ id: "s2", ownsQemu: false, attachedToShared: true }), false);
  });

  it("dispatch teardown detaches the VM and still rms Docker", () => {
    const start = dispatchSrc.indexOf("teardown_sandbox() {");
    const fn = dispatchSrc.slice(start, dispatchSrc.indexOf("\nstanding_status()", start));
    assert.match(fn, /vm\) cli="\$ROOT\/scripts\/gotchibot-vm\.mjs"; node "\$cli" detach "\$id"/);
    assert.match(fn, /sandbox\.mjs"; node "\$cli" rm "\$id"/);
    assert.doesNotMatch(fn, /gotchibot-vm\.mjs"; node "\$cli" rm/);
  });

  it("the bot attaches with up <sessionId> and exec <sessionId> against gbvm-shared", () => {
    assert.equal(SHARED_GUEST_ID, "shared");
    assert.match(dispatchSrc, /printf 'gbvm-shared\\n'/);
    assert.match(dispatchSrc, /gotchibot-vm\.mjs" exec "\$id"/);
    assert.match(dispatchSrc, /node "\$SANDBOX_CLI" up "\$id"/);
    assert.match(vmSrc, /planGuestUp\(/);
    assert.match(vmSrc, /attached \$\{sid\} to/);
    assert.match(vmSrc, /guest stays up/);
  });
});

describe("limits and host are unchanged", () => {
  it("still 2 vCPU, 2 GiB, 20G, and the 2020 iMac KVM check", () => {
    assert.match(vmSrc, /GOTCHIBOT_VM_CPUS", "2"/);
    assert.match(vmSrc, /GOTCHIBOT_VM_MEMORY_MB", "2048"/);
    assert.match(vmSrc, /GOTCHIBOT_VM_DISK", "20G"/);
    assert.match(vmSrc, /no \/dev\/kvm on \$\{here\(\)\}; VMs run on the 2020 iMac/);
    assert.match(vmSrc, /only one VM fits in the 2020 iMac's RAM/);
  });
});
