/**
 * A new project's chat must not resume another project's transcript.
 *   node --test tests/project-chat.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chatSessionFor, claimLegacyChat, rememberChatSession } from "../scripts/project-chat.mjs";

const AARCADE = "ses_aarcadechat0001";
const WONDR = "ses_wondrstackchat01";

describe("project chat pins", () => {
  it("keeps an unscoped pin on the legacy project and starts the next project empty", () => {
    const legacy = claimLegacyChat(
      { project: { sessionId: AARCADE, updatedAt: "2026-10-01T00:00:00.000Z" }, gotchi: { sessionId: AARCADE } },
      "aarcadeghst",
    );
    assert.equal(chatSessionFor(legacy, "aarcadeghst"), AARCADE);
    assert.equal(chatSessionFor(legacy, "wondrstack"), "");
  });

  it("remembering a new project's session does not replace the previous project's chat", () => {
    const legacy = claimLegacyChat({ project: { sessionId: AARCADE }, gotchi: { sessionId: AARCADE } }, "aarcadeghst");
    const next = rememberChatSession(legacy, "wondrstack", WONDR, "2026-10-04T04:00:00.000Z");
    assert.equal(chatSessionFor(next, "wondrstack"), WONDR);
    assert.equal(chatSessionFor(next, "aarcadeghst"), AARCADE);
    assert.equal(next.project.sessionId, AARCADE);
  });
});
