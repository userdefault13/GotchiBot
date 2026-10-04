/**
 * Desk project writes merge onto the hub client, and a pull applies the hub copy.
 * No live hub.
 *   node --test tests/hub-project-sync.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeSnapshotFiles,
  projectSyncPathOk,
} from "../services/gotchibot-api/projects.mjs";
import {
  applyHubProjectFiles,
  flushProjectWrites,
  publishProjectWrite,
  pullOpenProject,
  repoRel,
} from "../scripts/hub-project-sync.mjs";
import { chooseInboxDocument } from "../scripts/inbox-pane.mjs";

describe("project sync paths", () => {
  it("allows dossier, kanban, meet, and inbox, and rejects secrets", () => {
    for (const ok of [
      "sessions/pstack/alpha/dossier.json",
      "sessions/pstack/alpha/overview.md",
      "sessions/pstack/alpha/status.md",
      "sessions/pstack/alpha/roster.json",
      "sessions/pstack/alpha/kanban.json",
      "sessions/pstack/alpha/mail.json",
      "sessions/pstack/alpha/inbox/inbox.json",
      "sessions/pstack/alpha/desks/owned-1/kanban.json",
      "sessions/pstack/alpha/meetings/.current",
      "sessions/pstack/alpha/meetings/m20261002-1/meeting.json",
      "sessions/pstack/alpha/meetings/m20261002-1/transcript.jsonl",
      "sessions/pstack/alpha/meetings/m20261002-1/minutes.md",
    ]) {
      assert.equal(projectSyncPathOk(ok), true, ok);
    }
    for (const bad of [
      "sessions/.hub.json",
      "sessions/pstack/alpha/inbox/archive.json",
      "sessions/pstack/alpha/meetings/m1/handoff.md",
      "sessions/pstack/../x/dossier.json",
      "sessions/pstack/alpha/notes/x.md",
    ]) {
      assert.equal(projectSyncPathOk(bad), false, bad);
    }
  });

  it("merges one file without dropping the rest of the desk snapshot", () => {
    const merged = mergeSnapshotFiles(
      [
        { path: "sessions/pstack/alpha/dossier.json", text: '{"slug":"alpha"}', mtime: "2026-01-01T00:00:00.000Z" },
        { path: "sessions/pstack/alpha/kanban.json", text: '{"cards":[]}', mtime: "2026-01-01T00:00:00.000Z" },
      ],
      [{ path: "sessions/pstack/alpha/kanban.json", text: '{"cards":[{"id":"c1"}]}', mtime: "2026-10-02T00:00:00.000Z" }],
    );
    const byPath = Object.fromEntries(merged.map((f) => [f.path, f.text]));
    assert.equal(byPath["sessions/pstack/alpha/dossier.json"], '{"slug":"alpha"}');
    assert.match(byPath["sessions/pstack/alpha/kanban.json"], /c1/);
  });
});

describe("desk apply and publish", () => {
  it("pull writes a newer hub file and leaves a newer local file", () => {
    const root = mkdtempSync(join(tmpdir(), "gb-sync-"));
    try {
      const rel = "sessions/pstack/alpha/kanban.json";
      const abs = join(root, rel);
      mkdirSync(join(root, "sessions/pstack/alpha"), { recursive: true });
      writeFileSync(abs, '{"cards":[{"id":"local"}]}\n');
      const localMtime = new Date("2026-10-02T12:00:00.000Z");
      utimesSync(abs, localMtime, localMtime);

      const kept = applyHubProjectFiles(root, [
        { path: rel, text: '{"cards":[{"id":"hub-old"}]}\n', mtime: "2026-10-01T00:00:00.000Z" },
      ]);
      assert.deepEqual(kept, []);
      assert.match(readFileSync(abs, "utf8"), /local/);

      const wrote = applyHubProjectFiles(root, [
        { path: rel, text: '{"cards":[{"id":"hub"}]}\n', mtime: "2026-10-03T00:00:00.000Z" },
        { path: "sessions/pstack/alpha/inbox/inbox.json", text: '{"messages":[{"id":"b1"}]}\n', mtime: "2026-10-03T00:00:00.000Z" },
        { path: "sessions/.hub.json", text: "{}\n", mtime: "2026-10-03T00:00:00.000Z" },
      ]);
      assert.deepEqual(wrote.sort(), [
        "sessions/pstack/alpha/inbox/inbox.json",
        "sessions/pstack/alpha/kanban.json",
      ]);
      assert.match(readFileSync(abs, "utf8"), /hub/);
      assert.equal(statSync(abs).mtime.toISOString(), "2026-10-03T00:00:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a local write posts only that file to the hub files route", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-push-"));
    try {
      const rel = "sessions/pstack/alpha/dossier.json";
      const abs = join(root, rel);
      mkdirSync(join(root, "sessions/pstack/alpha"), { recursive: true });
      writeFileSync(abs, '{"slug":"alpha","fields":{"goal":"ship"}}\n');
      assert.equal(repoRel(root, abs), rel);
      let posted = null;
      assert.equal(
        publishProjectWrite(abs, {
          root,
          debounceMs: 60_000,
          hubRequest: async (method, path, opts) => {
            posted = { method, path, body: opts.body };
            return { ok: true, pushedAt: "2026-10-02T00:00:00.000Z" };
          },
        }),
        true,
      );
      const [result] = await flushProjectWrites();
      assert.equal(result.ok, true);
      assert.equal(posted.method, "POST");
      assert.equal(posted.path, "/api/gotchibot/projects/files");
      assert.deepEqual(
        posted.body.files.map((f) => f.path),
        [rel],
      );
      assert.match(posted.body.files[0].text, /ship/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pull applies the hub file list for the open project", async () => {
    const root = mkdtempSync(join(tmpdir(), "gb-pull-"));
    try {
      const rel = "sessions/pstack/alpha/meetings/m1/meeting.json";
      const result = await pullOpenProject({
        root,
        slug: "alpha",
        hubRequest: async (method, path) => {
          assert.equal(method, "GET");
          assert.equal(path, "/api/gotchibot/projects/alpha/files");
          return {
            ok: true,
            slug: "alpha",
            files: [{ path: rel, text: '{"id":"m1","status":"open"}\n', mtime: "2026-10-02T01:00:00.000Z" }],
          };
        },
      });
      assert.deepEqual(result.written, [rel]);
      assert.match(readFileSync(join(root, rel), "utf8"), /open/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("inbox pane source", () => {
  it("shows the bot inbox when project mail is empty", () => {
    const empty = chooseInboxDocument(
      { messages: [] },
      { messages: [{ id: "b1", subject: "hi", ts: "2026-10-02T00:00:00.000Z" }] },
    );
    assert.equal(empty.which, "bot");
    assert.equal(empty.messages[0].id, "b1");
    const mail = chooseInboxDocument(
      { messages: [{ id: "m1", subject: "mail", ts: "2026-10-02T00:00:00.000Z" }] },
      { messages: [{ id: "b1", subject: "bot", ts: "2026-10-02T00:00:00.000Z" }] },
    );
    assert.equal(mail.which, "mail");
    assert.equal(mail.messages[0].id, "m1");
  });
});

describe("one-shot CLI writes reach the hub", () => {
  it("flushes a queued push before the process exits on its own", async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execFileSync: run } = await import("node:child_process");
    const { join: j, resolve: r, dirname: d } = await import("node:path");
    const { fileURLToPath: f } = await import("node:url");
    const repo = r(d(f(import.meta.url)), "..");
    const root = mkdtempSync(j(tmpdir(), "gb-flush-"));
    const rel = "sessions/pstack/demo/meetings/m1/meeting.json";
    mk(j(root, "sessions/pstack/demo/meetings/m1"), { recursive: true });
    wf(j(root, rel), "{}\n");
    const probe = j(root, "probe.mjs");
    wf(
      probe,
      `import { publishProjectWrite } from ${JSON.stringify(j(repo, "scripts/hub-project-sync.mjs"))};
const hubRequest = async (m, p, { body }) => { await new Promise((ok) => setTimeout(ok, 50)); console.log("PUSHED " + body.files.map((x) => x.path).join(",")); return { ok: true }; };
publishProjectWrite(${JSON.stringify(j(root, rel))}, { root: ${JSON.stringify(root)}, hubRequest });
`,
    );
    const out = run(process.execPath, [probe], { encoding: "utf8" });
    assert.match(out, new RegExp(`PUSHED ${rel}`));
  });
});
