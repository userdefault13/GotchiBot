/**
 * Mongo data layer for gotchibot-api (official mongodb driver).
 */
import { MongoClient } from "mongodb";
import { canonicalJson, contentHashOf, ulid } from "../../scripts/chat-canonical.mjs";
import { formatStateUri } from "../../scripts/chat-state-uri.mjs";
import {
  hashToken,
  newDeskToken,
  newPairingCode,
  normalizePairingCode,
} from "./auth.mjs";

const PAIRING_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024;
const LAST_SEEN_MIN_MS = 60_000;

/**
 * @param {{ mongoUri: string, dbName: string }} opts
 */
export async function connectStore({ mongoUri, dbName }) {
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  const chatMessages = db.collection("chat_messages");
  const chatThreads = db.collection("chat_threads");
  const chatSnapshots = db.collection("chat_snapshots");
  const counters = db.collection("counters");
  const desks = db.collection("desks");
  const pairingCodes = db.collection("pairing_codes");

  async function ensureIndexes() {
    await chatMessages.createIndex({ threadId: 1, messageId: 1 }, { unique: true });
    await chatMessages.createIndex({ seq: 1 });
    await chatMessages.createIndex({ threadId: 1, seq: 1 });
    await chatThreads.createIndex({ threadId: 1 }, { unique: true });
    await chatSnapshots.createIndex({ snapshotId: 1 }, { unique: true });
    await desks.createIndex({ tokenHash: 1 }, { unique: true });
    await desks.createIndex({ deskId: 1 }, { unique: true });
    await pairingCodes.createIndex({ codeHash: 1 }, { unique: true });
    await pairingCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async function nextSeq() {
    const doc = await counters.findOneAndUpdate(
      { _id: "chat_seq" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    return doc.seq;
  }

  async function findDeskByToken(token) {
    if (!token || typeof token !== "string") return null;
    const tokenHash = hashToken(token);
    const desk = await desks.findOne({ tokenHash });
    if (!desk) return null;
    if (desk.revokedAt) return { ...desk, revoked: true };
    return desk;
  }

  async function touchLastSeen(deskId) {
    const now = new Date();
    const desk = await desks.findOne({ deskId });
    if (!desk) return;
    const last = desk.lastSeen ? new Date(desk.lastSeen).getTime() : 0;
    if (now.getTime() - last < LAST_SEEN_MIN_MS) return;
    await desks.updateOne({ deskId }, { $set: { lastSeen: now } });
  }

  async function mintPairingCode({ name } = {}) {
    const code = newPairingCode();
    const codeHash = hashToken(normalizePairingCode(code));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    await pairingCodes.insertOne({
      codeHash,
      name: name != null ? String(name).slice(0, 128) : null,
      createdAt: now,
      expiresAt,
      usedAt: null,
      usedByDeskId: null,
    });
    return { code, expiresAt };
  }

  async function claimPairingCode({ code, name } = {}) {
    const normalized = normalizePairingCode(code);
    if (!normalized || normalized.length !== 8) {
      const err = new Error("invalid pairing code");
      err.code = "INVALID_CODE";
      throw err;
    }
    const codeHash = hashToken(normalized);
    const now = new Date();
    const claimed = await pairingCodes.findOneAndUpdate(
      { codeHash, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { returnDocument: "after" },
    );
    if (!claimed) {
      const err = new Error("pairing code invalid or expired");
      err.code = "INVALID_CODE";
      throw err;
    }

    const deskToken = newDeskToken();
    const deskId = ulid();
    const deskName =
      (name != null && String(name).trim()) ||
      (claimed.name && String(claimed.name)) ||
      "desk";
    await desks.insertOne({
      deskId,
      name: String(deskName).slice(0, 128),
      tokenHash: hashToken(deskToken),
      createdAt: now,
      lastSeen: now,
      revokedAt: null,
    });
    await pairingCodes.updateOne(
      { codeHash },
      { $set: { usedByDeskId: deskId } },
    );
    return { deskId, deskToken, name: String(deskName).slice(0, 128) };
  }

  async function listDesks() {
    const rows = await desks.find({}).sort({ createdAt: -1 }).toArray();
    return rows.map((d) => ({
      deskId: d.deskId,
      name: d.name,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      revokedAt: d.revokedAt ?? null,
    }));
  }

  async function revokeDesk(deskId) {
    const r = await desks.updateOne(
      { deskId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return r.modifiedCount > 0;
  }

  /**
   * @param {{ threadId: string, title?: string, thread?: object, messages: object[], deskId: string }} input
   */
  async function pushMessages(input) {
    const threadId = String(input.threadId || "").trim();
    if (threadId.length < 1 || threadId.length > 128) {
      const err = new Error("threadId must be 1-128 chars");
      err.status = 400;
      throw err;
    }
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (!messages.length) {
      const err = new Error("messages array required");
      err.status = 400;
      throw err;
    }
    if (messages.length > 200) {
      const err = new Error("max 200 messages per push");
      err.status = 400;
      throw err;
    }

    const deskId = input.deskId;
    const now = new Date();
    const results = [];
    let inserted = 0;
    let skipped = 0;
    let lastSeq = 0;
    let lastMessageAt = null;

    for (const raw of messages) {
      const messageId = String(raw.messageId || raw.msgId || "").trim();
      if (!messageId || messageId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(messageId)) {
        const err = new Error(`invalid messageId: ${messageId}`);
        err.status = 400;
        throw err;
      }
      const op = String(raw.op || "message").toLowerCase();
      if (!["message", "edit", "delete"].includes(op)) {
        const err = new Error(`invalid op: ${op}`);
        err.status = 400;
        throw err;
      }
      let targetMessageId = null;
      if (op === "edit" || op === "delete") {
        targetMessageId = String(raw.targetMessageId || "").trim();
        if (!targetMessageId) {
          const err = new Error(`${op} requires targetMessageId`);
          err.status = 400;
          throw err;
        }
      }
      const role = String(raw.role || "user").trim().slice(0, 32);
      const text =
        op === "delete"
          ? ""
          : String(raw.text ?? "").slice(0, 32_000);
      const ts = raw.ts ? new Date(raw.ts) : now;
      if (Number.isNaN(ts.getTime())) {
        const err = new Error(`invalid ts for ${messageId}`);
        err.status = 400;
        throw err;
      }
      const heroId =
        raw.heroId != null ? String(raw.heroId).slice(0, 128) : null;

      const existing = await chatMessages.findOne({ threadId, messageId });
      if (existing) {
        skipped += 1;
        lastSeq = Math.max(lastSeq, existing.seq);
        results.push({
          messageId,
          seq: existing.seq,
          status: "duplicate",
        });
        continue;
      }

      let seq;
      try {
        seq = await nextSeq();
        await chatMessages.insertOne({
          threadId,
          messageId,
          seq,
          role,
          text,
          ts,
          op,
          targetMessageId,
          deskId,
          heroId,
          createdAt: now,
        });
        inserted += 1;
        lastSeq = Math.max(lastSeq, seq);
        lastMessageAt = ts;
        results.push({ messageId, seq, status: "inserted" });
      } catch (err) {
        if (err?.code === 11000) {
          const dup = await chatMessages.findOne({ threadId, messageId });
          skipped += 1;
          if (dup) {
            lastSeq = Math.max(lastSeq, dup.seq);
            results.push({
              messageId,
              seq: dup.seq,
              status: "duplicate",
            });
          }
          continue;
        }
        throw err;
      }
    }

    await upsertThreadMeta({
      threadId,
      deskId,
      title: input.title ?? input.thread?.title,
      updatedAt: input.thread?.updatedAt
        ? new Date(input.thread.updatedAt)
        : input.title != null
          ? now
          : null,
      hasThreadMeta:
        input.title != null ||
        input.thread?.title != null ||
        input.thread?.updatedAt != null,
      lastSeq,
      lastMessageAt: lastMessageAt || now,
      now,
    });

    // lastSeq from counter if nothing inserted
    if (!lastSeq && results.length) {
      lastSeq = Math.max(...results.map((r) => r.seq));
    }

    return {
      ok: true,
      threadId,
      inserted,
      skipped,
      lastSeq,
      results,
    };
  }

  async function upsertThreadMeta({
    threadId,
    deskId,
    title,
    updatedAt,
    hasThreadMeta,
    lastSeq,
    lastMessageAt,
    now,
  }) {
    const existing = await chatThreads.findOne({ threadId });
    const incomingTitle =
      title != null ? String(title).trim().slice(0, 200) : null;
    const incomingUpdatedAt =
      updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : now;

    if (!existing) {
      try {
        await chatThreads.insertOne({
          threadId,
          title: incomingTitle || threadId,
          updatedAt: hasThreadMeta ? incomingUpdatedAt : now,
          deskId,
          lastSeq: lastSeq || 0,
          lastMessageAt,
          createdAt: now,
        });
      } catch (err) {
        if (err?.code === 11000) {
          return upsertThreadMeta({
            threadId,
            deskId,
            title,
            updatedAt,
            hasThreadMeta,
            lastSeq,
            lastMessageAt,
            now,
          });
        }
        throw err;
      }
      return;
    }

    const set = {};
    const maxFields = {};

    if (hasThreadMeta && incomingTitle != null) {
      const storedAt = existing.updatedAt
        ? new Date(existing.updatedAt).getTime()
        : 0;
      const inAt = incomingUpdatedAt.getTime();
      const storedDesk = String(existing.deskId || "");
      const inDesk = String(deskId || "");
      if (
        inAt > storedAt ||
        (inAt === storedAt && inDesk > storedDesk)
      ) {
        set.title = incomingTitle;
        set.updatedAt = incomingUpdatedAt;
        set.deskId = deskId;
      }
    }

    if (lastSeq) maxFields.lastSeq = lastSeq;
    if (lastMessageAt) maxFields.lastMessageAt = lastMessageAt;

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(maxFields).length) update.$max = maxFields;
    if (Object.keys(update).length) {
      await chatThreads.updateOne({ threadId }, update);
    }
  }

  async function pullMessages({ threadId, after = 0, limit = 100 } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const afterSeq = Number(after) || 0;
    const filter = { seq: { $gt: afterSeq } };
    if (threadId) filter.threadId = String(threadId).trim();

    const rows = await chatMessages
      .find(filter)
      .sort({ seq: 1 })
      .limit(lim)
      .toArray();

    const messages = rows.map((r) => ({
      threadId: r.threadId,
      messageId: r.messageId,
      seq: r.seq,
      role: r.role,
      text: r.text,
      ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
      op: r.op || "message",
      ...(r.targetMessageId ? { targetMessageId: r.targetMessageId } : {}),
      deskId: r.deskId,
      ...(r.heroId ? { heroId: r.heroId } : {}),
    }));

    const nextAfter = messages.length
      ? messages[messages.length - 1].seq
      : afterSeq;
    return {
      ok: true,
      threadId: threadId ? String(threadId).trim() : null,
      messages,
      nextAfter,
      hasMore: messages.length === lim,
    };
  }

  async function listThreads({ limit = 100 } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = await chatThreads
      .find({})
      .sort({ updatedAt: -1 })
      .limit(lim)
      .toArray();
    return {
      ok: true,
      threads: rows.map((t) => ({
        threadId: t.threadId,
        title: t.title,
        updatedAt:
          t.updatedAt instanceof Date
            ? t.updatedAt.toISOString()
            : t.updatedAt,
        deskId: t.deskId,
        lastSeq: t.lastSeq || 0,
        lastMessageAt:
          t.lastMessageAt instanceof Date
            ? t.lastMessageAt.toISOString()
            : t.lastMessageAt,
      })),
    };
  }

  async function createSnapshot({
    threadIds,
    gitCommit,
    gitBranch,
    deskId,
  } = {}) {
    const filter =
      Array.isArray(threadIds) && threadIds.length
        ? { threadId: { $in: threadIds.map(String) } }
        : {};
    const threads = await chatThreads.find(filter).sort({ threadId: 1 }).toArray();
    const threadOut = [];
    let upToSeq = 0;
    let messageCount = 0;

    for (const t of threads) {
      const msgs = await chatMessages
        .find({ threadId: t.threadId })
        .sort({ seq: 1 })
        .toArray();
      messageCount += msgs.length;
      for (const m of msgs) upToSeq = Math.max(upToSeq, m.seq);
      threadOut.push({
        threadId: t.threadId,
        title: t.title,
        messages: msgs.map((m) => ({
          messageId: m.messageId,
          seq: m.seq,
          role: m.role,
          text: m.text,
          ts: m.ts instanceof Date ? m.ts.toISOString() : String(m.ts),
          op: m.op || "message",
          ...(m.targetMessageId ? { targetMessageId: m.targetMessageId } : {}),
          deskId: m.deskId,
          ...(m.heroId ? { heroId: m.heroId } : {}),
        })),
      });
    }

    threadOut.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));

    const createdAt = new Date().toISOString();
    const content = {
      v: 1,
      kind: "gotchibot-chat-snapshot",
      createdAt,
      gitCommit: gitCommit != null ? String(gitCommit) : null,
      gitBranch: gitBranch != null ? String(gitBranch) : null,
      upToSeq,
      threads: threadOut,
    };

    const canon = canonicalJson(content);
    if (Buffer.byteLength(canon, "utf8") > SNAPSHOT_MAX_BYTES) {
      const err = new Error("snapshot too large — pass threadIds");
      err.status = 413;
      throw err;
    }

    const contentHash = contentHashOf(content);
    const snapshotId = ulid();
    const stateUri = formatStateUri("gotchibot-hub", snapshotId);
    const created = new Date();

    await chatSnapshots.insertOne({
      snapshotId,
      contentHash,
      stateUri,
      content,
      createdAt: created,
      deskId,
    });

    return {
      ok: true,
      snapshotId,
      contentHash,
      stateUri,
      messageCount,
      threadIds: threadOut.map((t) => t.threadId),
      upToSeq,
      createdAt: created.toISOString(),
    };
  }

  async function getSnapshot(snapshotId) {
    const id = String(snapshotId || "").trim();
    const snap = await chatSnapshots.findOne({ snapshotId: id });
    if (!snap) return null;
    return {
      ok: true,
      snapshotId: snap.snapshotId,
      contentHash: snap.contentHash,
      stateUri: snap.stateUri,
      content: snap.content,
      createdAt:
        snap.createdAt instanceof Date
          ? snap.createdAt.toISOString()
          : snap.createdAt,
    };
  }

  async function close() {
    await client.close();
  }

  return {
    db,
    client,
    ensureIndexes,
    findDeskByToken,
    touchLastSeen,
    mintPairingCode,
    claimPairingCode,
    listDesks,
    revokeDesk,
    pushMessages,
    pullMessages,
    listThreads,
    createSnapshot,
    getSnapshot,
    close,
  };
}
