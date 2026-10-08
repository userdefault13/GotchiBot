/**
 * @mentions in the meet room reach any roster gotchi or seated hero.
 *   node --test tests/meet-mentions.test.mjs
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deskMentionTargets, mentionTag, resolveDeskMention } from "../scripts/lib/meet-mentions.mjs";
import { bindWorker, ensureProjectDirs } from "../scripts/project-context.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "meet-mentions-"));
const slug = `zz-mm-${randomBytes(3).toString("hex")}`;
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(path.join(repo, "sessions", "pstack", slug), { recursive: true, force: true });
});
mkdirSync(path.join(tmp, "sessions"), { recursive: true });
writeFileSync(
  path.join(tmp, "sessions", ".avatar-roster.json"),
  JSON.stringify({
    pinned: "owned-22899",
    pinnedName: "User0xDefault",
    others: [
      { id: "owned-10503", name: "UserDefault" },
      { id: "owned-12302", name: "User.Default" },
      { id: "owned-16263", name: "UserDef@ult.Aave" },
      { id: "hero:kanban-manager", name: "" },
    ],
  }),
);

describe("meet @mentions", () => {
  it("tags keep only mention characters", () => {
    assert.equal(mentionTag("User.Default"), "@User.Default");
    assert.equal(mentionTag("UserDef@ult.Aave"), "@UserDefult.Aave");
    assert.equal(mentionTag("Prof. Link-Cube"), "@Prof.Link-Cube");
    assert.equal(mentionTag("", "owned-1"), "@owned-1");
  });

  it("offers every roster gotchi and each seated hero (speaking to its worker)", () => {
    ensureProjectDirs(slug);
    bindWorker("chief-of-staff", "owned-12302", slug);
    const t = deskMentionTargets({ root: tmp, slug });
    assert.deepEqual(t[0], { tag: "@chief-of-staff", label: "chief of staff · User.Default", id: "owned-12302", kind: "hero" });
    assert.deepEqual(t.map((x) => x.tag).slice(1), ["@User0xDefault", "@UserDefault", "@User.Default", "@UserDefult.Aave"]);
    assert.equal(t.some((x) => x.id.startsWith("hero:")), false, "no unbound hero tiles");
  });

  it("resolves a mention to one gotchi; a dot tells User.Default from UserDefault", () => {
    const t = deskMentionTargets({ root: tmp, slug });
    assert.equal(resolveDeskMention("@chief-of-staff", t), "owned-12302");
    assert.equal(resolveDeskMention("User.Default", t), "owned-12302");
    assert.equal(resolveDeskMention("@UserDefault", t), "owned-10503");
    assert.equal(resolveDeskMention("owned-16263", t), "owned-16263");
    assert.equal(resolveDeskMention("@nobody", t), null);
  });

  it("is wired: the room menu lists desk targets; a mention outside the room invites them", () => {
    const room = readFileSync(path.join(repo, "scripts/meet-room-prompter.mjs"), "utf8");
    assert.match(room, /deskMentionTargets\(\)/);
    assert.match(room, /@\(\[A-Za-z0-9_\.-\]\*\)\$/);
    const meet = readFileSync(path.join(repo, "scripts/gotchi-meet.mjs"), "utf8");
    assert.match(meet, /await inviteMentioned\(meeting, text\)/);
  });
});
