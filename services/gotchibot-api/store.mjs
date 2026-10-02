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
  newVerifyCode,
  normalizePairingCode,
} from "./auth.mjs";

const PAIRING_TTL_MS = 15 * 60 * 1000;
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000;
const VERIFY_CODE_RE = /^gbv_[A-Za-z0-9_-]{32}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WALLET_NONCE_TTL_MS = 5 * 60 * 1000;
const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SNAPSHOT_MAX_BYTES = 12 * 1024 * 1024;
const LAST_SEEN_MIN_MS = 60_000;
/** Trusted server-side writer for hub-runner assistant replies (not an HTTP desk). */
const HUB_RUNNER_DESK_ID = "hub-runner";
/** Claimed replies older than this are reclaimable / retryable. */
const REPLY_STALE_MS = 5 * 60 * 1000;
/** Runner considered offline if lastBeatAt older than this. */
const RUNNER_OFFLINE_MS = 90_000;
const MSG_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Owner of project desk threads (created by the Hub, visible to every desk). */
const HUB_DESK_ID = "hub-desk";
const DESK_THREAD_PREFIX = "desk-";

export function deskThreadId(slug) {
  return `${DESK_THREAD_PREFIX}${slug}`;
}

/** Strip obvious secret-looking substrings from error/detail strings. */
function sanitizePublicText(value, max = 200) {
  let s = String(value ?? "")
    .replace(/gbd_[A-Za-z0-9_-]+/gi, "gbd_***")
    .replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, "mongodb://***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
  s = s.trim().slice(0, max);
  return s || null;
}

function validateMessageId(raw) {
  const messageId = String(raw || "").trim();
  if (!messageId || messageId.length > 128 || !MSG_ID_RE.test(messageId)) {
    const err = new Error(`invalid messageId: ${messageId}`);
    err.status = 400;
    throw err;
  }
  return messageId;
}

/** Serialize reply tracking for pull / API (dates → ISO). Omits nothing secret. */
function publicReply(reply) {
  if (!reply || typeof reply !== "object") return undefined;
  const out = { status: String(reply.status || "pending") };
  for (const key of [
    "requestedAt",
    "claimedAt",
    "repliedAt",
    "failedAt",
  ]) {
    if (reply[key]) {
      out[key] =
        reply[key] instanceof Date
          ? reply[key].toISOString()
          : String(reply[key]);
    }
  }
  if (reply.replyMessageId != null) out.replyMessageId = String(reply.replyMessageId);
  if (reply.model != null) out.model = String(reply.model);
  if (reply.error != null) out.error = String(reply.error);
  if (reply.attempts != null) out.attempts = Number(reply.attempts) || 0;
  if (reply.runnerId != null) out.runnerId = String(reply.runnerId);
  return out;
}

/** null when absent; 400 when present but not a pstack slug. */
function normalizeProjectSlug(project) {
  if (project == null || String(project).trim() === "") return null;
  const slug = String(project).trim();
  if (!PROJECT_SLUG_RE.test(slug)) {
    const err = new Error("invalid project slug");
    err.status = 400;
    throw err;
  }
  return slug;
}

/** @param {unknown} kind @returns {"desk"|"phone"} */
function normalizeDeskKind(kind, { defaultKind = "desk" } = {}) {
  if (kind == null || kind === "") return defaultKind;
  const k = String(kind).trim().toLowerCase();
  if (k !== "desk" && k !== "phone") {
    const err = new Error("invalid kind — must be desk or phone");
    err.status = 400;
    throw err;
  }
  return k;
}

/** Desk kind for access checks; missing/legacy → "desk". */
function deskKindOf(desk) {
  if (!desk) return "desk";
  const k = desk.kind != null ? String(desk.kind).trim().toLowerCase() : "";
  return k === "phone" ? "phone" : "desk";
}

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
  const hubRunner = db.collection("hub_runner");
  const walletNonces = db.collection("wallet_nonces");
  /** One-time links that let a paired phone prove the owner wallet from a wallet browser. */
  const walletVerifyCodes = db.collection("wallet_verify_codes");
  const projectSnapshot = db.collection("project_snapshot");
  const cockpitSnapshot = db.collection("cockpit_snapshot");
  /** deskId → that desk's agent-tree snapshot (Factory Tree view, merged by readers). */
  const treeSnapshots = db.collection("tree_snapshots");
  /** slug → { sessionId, threadId, lastMirroredId }: the project's OpenCode desk session. */
  const deskSessions = db.collection("desk_sessions");

  async function ensureIndexes() {
    await chatMessages.createIndex({ threadId: 1, messageId: 1 }, { unique: true });
    await chatMessages.createIndex({ seq: 1 });
    await chatMessages.createIndex({ threadId: 1, seq: 1 });
    // Claim queue: oldest phone-originated user msg with reply pending / stale claimed
    await chatMessages.createIndex({
      originKind: 1,
      "reply.status": 1,
      "reply.requestedAt": 1,
      seq: 1,
    });
    await chatThreads.createIndex({ threadId: 1 }, { unique: true });
    await chatThreads.createIndex({ createdByDeskId: 1 });
    await chatThreads.createIndex({ sharedWithDeskIds: 1 });
    await chatSnapshots.createIndex({ snapshotId: 1 }, { unique: true });
    await desks.createIndex({ tokenHash: 1 }, { unique: true });
    await desks.createIndex({ deskId: 1 }, { unique: true });
    await pairingCodes.createIndex({ codeHash: 1 }, { unique: true });
    await pairingCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await chatThreads.createIndex({ project: 1, updatedAt: -1 });
    await walletNonces.createIndex({ nonce: 1 }, { unique: true });
    await walletNonces.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await walletVerifyCodes.createIndex({ codeHash: 1 }, { unique: true });
    await walletVerifyCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  function threadAccessibleToPhone(thread, deskId) {
    if (!thread) return false;
    if (thread.kind === "desk") return true;
    if (thread.createdByDeskId === deskId) return true;
    const shared = Array.isArray(thread.sharedWithDeskIds)
      ? thread.sharedWithDeskIds
      : [];
    return shared.includes(deskId);
  }

  /**
   * Phone write gate: existing unshared → 403; missing → create owned by phone
   * before any message insert (closes create-race with another desk).
   */
  async function ensurePhoneCanWriteThread(desk, threadId, { title, now } = {}) {
    const existing = await chatThreads.findOne({ threadId });
    if (existing) {
      if (!threadAccessibleToPhone(existing, desk.deskId)) {
        const err = new Error("thread not shared with this desk");
        err.status = 403;
        throw err;
      }
      return;
    }
    if (threadId.startsWith(DESK_THREAD_PREFIX)) {
      const err = new Error("open the project to start its desk");
      err.status = 403;
      throw err;
    }
    const incomingTitle =
      title != null ? String(title).trim().slice(0, 200) : null;
    try {
      await chatThreads.insertOne({
        threadId,
        title: incomingTitle || threadId,
        updatedAt: now,
        deskId: desk.deskId,
        createdByDeskId: desk.deskId,
        sharedWithDeskIds: [],
        lastSeq: 0,
        lastMessageAt: null,
        createdAt: now,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const again = await chatThreads.findOne({ threadId });
      if (!threadAccessibleToPhone(again, desk.deskId)) {
        const e = new Error("thread not shared with this desk");
        e.status = 403;
        throw e;
      }
    }
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

  /**
   * @param {{ name?: string, kind?: string, walletAddress?: string|null }} [opts]
   *   walletAddress: set only by a verified owner-wallet handoff; the claimed desk inherits it.
   */
  async function mintPairingCode({ name, kind, walletAddress = null } = {}) {
    const deskKind = normalizeDeskKind(kind);
    const code = newPairingCode();
    const codeHash = hashToken(normalizePairingCode(code));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    await pairingCodes.insertOne({
      codeHash,
      name: name != null ? String(name).slice(0, 128) : null,
      kind: deskKind,
      walletAddress:
        walletAddress && ADDRESS_RE.test(String(walletAddress))
          ? String(walletAddress).toLowerCase()
          : null,
      createdAt: now,
      expiresAt,
      usedAt: null,
      usedByDeskId: null,
    });
    return { code, expiresAt, kind: deskKind };
  }

  async function claimPairingCode({ code, name, kind } = {}) {
    const normalized = normalizePairingCode(code);
    if (!normalized || normalized.length !== 8) {
      const err = new Error("invalid pairing code");
      err.code = "INVALID_CODE";
      throw err;
    }

    let claimKind = null;
    if (kind != null && kind !== "") {
      claimKind = normalizeDeskKind(kind);
    }

    const codeHash = hashToken(normalized);
    const now = new Date();

    // Peek before consume so kind-mismatch does not burn the code.
    const pending = await pairingCodes.findOne({
      codeHash,
      usedAt: null,
      expiresAt: { $gt: now },
    });
    if (!pending) {
      const err = new Error("pairing code invalid or expired");
      err.code = "INVALID_CODE";
      throw err;
    }

    const codeKind = normalizeDeskKind(pending.kind);
    let finalKind = codeKind;
    if (claimKind != null) {
      if (claimKind === "desk" && codeKind === "phone") {
        const err = new Error("kind mismatch");
        err.status = 403;
        throw err;
      }
      // Downgrade desk→phone allowed; same-kind ok.
      finalKind = claimKind;
    }

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

    const deskName =
      (name != null && String(name).trim()) ||
      (claimed.name && String(claimed.name)) ||
      "desk";
    const issued = await insertDesk({
      name: deskName,
      kind: finalKind,
      walletAddress: claimed.walletAddress || null,
      now,
    });
    await pairingCodes.updateOne(
      { codeHash },
      { $set: { usedByDeskId: issued.deskId } },
    );
    return issued;
  }

  /** Mint a desk row + fresh token (token returned once, only its hash stored). */
  async function insertDesk({ name, kind, walletAddress = null, now = new Date() }) {
    const deskToken = newDeskToken();
    const deskId = ulid();
    const deskName = String(name).slice(0, 128);
    await desks.insertOne({
      deskId,
      name: deskName,
      kind,
      tokenHash: hashToken(deskToken),
      ...(walletAddress ? { walletAddress } : {}),
      createdAt: now,
      lastSeen: now,
      revokedAt: null,
    });
    return {
      deskId,
      deskToken,
      name: deskName,
      kind,
      ...(walletAddress ? { walletAddress } : {}),
    };
  }

  /**
   * One-time sign-in nonce. The caller builds the message; we store it so
   * login verifies exactly what was issued.
   * @param {{ nonce: string, message: string, now?: Date }} input
   */
  async function mintWalletNonce({ nonce, message, now = new Date() }) {
    const expiresAt = new Date(now.getTime() + WALLET_NONCE_TTL_MS);
    await walletNonces.insertOne({ nonce, message, createdAt: now, expiresAt });
    return { nonce, message, expiresAt };
  }

  /** Atomically consume an unexpired nonce → its message, or null. */
  async function consumeWalletNonce(nonce) {
    if (!nonce || typeof nonce !== "string") return null;
    const doc = await walletNonces.findOneAndDelete({
      nonce,
      expiresAt: { $gt: new Date() },
    });
    return doc ? { nonce: doc.nonce, message: doc.message } : null;
  }

  /** Phone desk minted by a verified owner-wallet signature. */
  async function createWalletDesk({ address, name }) {
    const deskName = (name != null && String(name).trim()) || "iPhone";
    return insertDesk({
      name: deskName,
      kind: "phone",
      walletAddress: String(address).toLowerCase(),
    });
  }

  /** One-time verify link for a paired desk (only the hash is stored). */
  async function mintVerifyCode(deskId, { now = new Date() } = {}) {
    const code = newVerifyCode();
    const expiresAt = new Date(now.getTime() + VERIFY_CODE_TTL_MS);
    await walletVerifyCodes.insertOne({
      codeHash: hashToken(code),
      deskId: String(deskId),
      createdAt: now,
      expiresAt,
    });
    return { code, expiresAt };
  }

  /** Atomically consume an unexpired verify code → its deskId, or null. */
  async function consumeVerifyCode(code) {
    if (!code || typeof code !== "string" || !VERIFY_CODE_RE.test(code)) return null;
    const doc = await walletVerifyCodes.findOneAndDelete({
      codeHash: hashToken(code),
      expiresAt: { $gt: new Date() },
    });
    return doc ? { deskId: doc.deskId } : null;
  }

  /** Bind a verified owner wallet to an existing (non-revoked) desk. */
  async function setDeskWallet(deskId, address) {
    if (!ADDRESS_RE.test(String(address || ""))) {
      const err = new Error("invalid wallet address");
      err.status = 400;
      throw err;
    }
    const r = await desks.updateOne(
      { deskId: String(deskId), revokedAt: null },
      { $set: { walletAddress: String(address).toLowerCase(), walletVerifiedAt: new Date() } },
    );
    return r.matchedCount > 0;
  }

  async function listDesks() {
    const rows = await desks.find({}).sort({ createdAt: -1 }).toArray();
    return rows.map((d) => ({
      deskId: d.deskId,
      name: d.name,
      kind: deskKindOf(d),
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
   * @param {object|null|undefined} desk
   * @returns {object} Mongo filter for chat_threads
   */
  function visibleThreadFilter(desk) {
    if (!desk || deskKindOf(desk) !== "phone") return {};
    const deskId = desk.deskId;
    return {
      $or: [
        { createdByDeskId: deskId },
        { sharedWithDeskIds: deskId },
        { kind: "desk" },
      ],
    };
  }

  async function canDeskAccessThread(desk, threadId) {
    if (!desk || deskKindOf(desk) !== "phone") return true;
    const id = String(threadId || "").trim();
    if (!id) return false;
    const thread = await chatThreads.findOne({ threadId: id });
    return threadAccessibleToPhone(thread, desk.deskId);
  }

  async function shareThread(threadId, deskId) {
    const tid = String(threadId || "").trim();
    const did = String(deskId || "").trim();
    const thread = await chatThreads.findOne({ threadId: tid });
    if (!thread) {
      const err = new Error("thread not found");
      err.status = 404;
      throw err;
    }
    const desk = await desks.findOne({ deskId: did });
    if (!desk) {
      const err = new Error("desk not found");
      err.status = 404;
      throw err;
    }
    if (desk.revokedAt) {
      const err = new Error("desk revoked");
      err.status = 409;
      throw err;
    }
    const before = Array.isArray(thread.sharedWithDeskIds)
      ? thread.sharedWithDeskIds
      : [];
    const already = before.includes(did);
    await chatThreads.updateOne(
      { threadId: tid },
      { $addToSet: { sharedWithDeskIds: did } },
    );
    return {
      ok: true,
      threadId: tid,
      deskId: did,
      changed: !already,
      deskKind: deskKindOf(desk),
    };
  }

  async function unshareThread(threadId, deskId) {
    const tid = String(threadId || "").trim();
    const did = String(deskId || "").trim();
    const thread = await chatThreads.findOne({ threadId: tid });
    if (!thread) {
      const err = new Error("thread not found");
      err.status = 404;
      throw err;
    }
    const before = Array.isArray(thread.sharedWithDeskIds)
      ? thread.sharedWithDeskIds
      : [];
    const had = before.includes(did);
    await chatThreads.updateOne(
      { threadId: tid },
      { $pull: { sharedWithDeskIds: did } },
    );
    return { ok: true, changed: had };
  }

  async function listThreadShares(threadId) {
    const tid = String(threadId || "").trim();
    const thread = await chatThreads.findOne({ threadId: tid });
    if (!thread) {
      const err = new Error("thread not found");
      err.status = 404;
      throw err;
    }
    return Array.isArray(thread.sharedWithDeskIds)
      ? [...thread.sharedWithDeskIds]
      : [];
  }

  /**
   * @param {{ threadId: string, title?: string, thread?: object, messages: object[], deskId: string, desk?: object }} input
   *
   * Phone desks (kind "phone"):
   * - may only write op "message" (edit/delete → 403)
   * - role forced to "user" (assistant/system ignored)
   * - empty/whitespace-only text → 400
   * - cannot write existing unshared threads → 403
   * - new threadId is owned by the phone (createdByDeskId); race-safe pre-create
   * - stamps originKind:"phone" + reply:{status:"pending",requestedAt}
   *
   * Desk / hub-runner pushes are unchanged (no reply tracking).
   * Trusted runner: call with deskId HUB_RUNNER_DESK_ID (or any non-phone desk).
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
    const desk = input.desk || (deskId ? await desks.findOne({ deskId }) : null);
    const isPhone = desk && deskKindOf(desk) === "phone";
    const now = new Date();

    // Phone must not push into an existing unshared thread; claim ownership
    // of a new threadId before inserts so a race cannot steal the id.
    let inDeskThread = false;
    if (isPhone) {
      await ensurePhoneCanWriteThread(desk, threadId, {
        title: input.title ?? input.thread?.title,
        now,
      });
      const meta = await chatThreads.findOne({ threadId }, { projection: { kind: 1 } });
      inDeskThread = meta?.kind === "desk";
    }

    const results = [];
    let inserted = 0;
    let skipped = 0;
    let lastSeq = 0;
    let lastMessageAt = null;

    for (const raw of messages) {
      const messageId = validateMessageId(raw.messageId || raw.msgId);
      let op = String(raw.op || "message").toLowerCase();
      if (!["message", "edit", "delete"].includes(op)) {
        const err = new Error(`invalid op: ${op}`);
        err.status = 400;
        throw err;
      }
      if (isPhone && op !== "message") {
        const err = new Error("phone desks may only push op message");
        err.status = 403;
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
      let role = String(raw.role || "user").trim().slice(0, 32);
      if (isPhone) role = "user";
      const text =
        op === "delete"
          ? ""
          : String(raw.text ?? "").slice(0, 32_000);
      if (isPhone && op === "message" && !text.trim()) {
        const err = new Error("text required");
        err.status = 400;
        throw err;
      }
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
          ...(existing.reply ? { reply: publicReply(existing.reply) } : {}),
        });
        continue;
      }

      let seq;
      try {
        seq = await nextSeq();
        const doc = {
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
        };
        if (isPhone && op === "message") {
          doc.originKind = "phone";
          if (inDeskThread) doc.threadKind = "desk";
          doc.reply = {
            status: "pending",
            requestedAt: now,
            attempts: 0,
          };
        }
        await chatMessages.insertOne(doc);
        inserted += 1;
        lastSeq = Math.max(lastSeq, seq);
        lastMessageAt = ts;
        results.push({
          messageId,
          seq,
          status: "inserted",
          ...(doc.reply ? { reply: publicReply(doc.reply) } : {}),
        });
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
              ...(dup.reply ? { reply: publicReply(dup.reply) } : {}),
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

  /**
   * Phone-friendly send: one user message, optional new thread.
   * Uses pushMessages so phone scoping / hardening apply.
   */
  async function sendMessage({ desk, threadId, clientMessageId, text, title, project } = {}) {
    if (!desk) {
      const err = new Error("desk required");
      err.status = 401;
      throw err;
    }
    const bodyText = String(text ?? "");
    if (!bodyText.trim()) {
      const err = new Error("text required");
      err.status = 400;
      throw err;
    }
    const creating = threadId == null || String(threadId).trim() === "";
    const projectSlug = normalizeProjectSlug(project);
    const tid = creating ? ulid() : String(threadId).trim();
    const messageId = clientMessageId
      ? validateMessageId(clientMessageId)
      : ulid();
    let resolvedTitle = title != null ? String(title) : undefined;
    if (creating && resolvedTitle == null) {
      resolvedTitle = bodyText.trim().slice(0, 60);
    }
    const result = await pushMessages({
      threadId: tid,
      title: resolvedTitle,
      messages: [
        {
          messageId,
          role: "user",
          text: bodyText.slice(0, 32_000),
          op: "message",
        },
      ],
      deskId: desk.deskId,
      desk,
    });
    if (creating && projectSlug) {
      await chatThreads.updateOne({ threadId: tid }, { $set: { project: projectSlug } });
    }
    const row = result.results?.[0] || {};
    const replyStatus =
      row.reply?.status ||
      (deskKindOf(desk) === "phone" ? "pending" : "none");
    return {
      ok: true,
      threadId: tid,
      ...(creating && projectSlug ? { project: projectSlug } : {}),
      messageId,
      seq: row.seq,
      reply: { status: replyStatus },
    };
  }

  /**
   * Reset reply.status to pending when error or stale claimed.
   * Inaccessible thread → 404 (no existence leak, same as pull).
   */
  async function retryReply({
    desk,
    threadId,
    messageId,
    staleMs = REPLY_STALE_MS,
  } = {}) {
    if (!desk) {
      const err = new Error("desk required");
      err.status = 401;
      throw err;
    }
    const tid = String(threadId || "").trim();
    const mid = String(messageId || "").trim();
    if (!tid || !mid) {
      const err = new Error("threadId and messageId required");
      err.status = 400;
      throw err;
    }
    const ok = await canDeskAccessThread(desk, tid);
    if (!ok) {
      const err = new Error("thread not found");
      err.status = 404;
      throw err;
    }
    const msg = await chatMessages.findOne({ threadId: tid, messageId: mid });
    if (!msg || msg.originKind !== "phone") {
      const err = new Error("message not found");
      err.status = 404;
      throw err;
    }
    const st = msg.reply?.status;
    const claimedAt = msg.reply?.claimedAt
      ? new Date(msg.reply.claimedAt).getTime()
      : 0;
    const staleClaimed =
      st === "claimed" &&
      Number.isFinite(claimedAt) &&
      Date.now() - claimedAt > (Number(staleMs) || REPLY_STALE_MS);
    if (st !== "error" && !staleClaimed) {
      const err = new Error("reply not retryable");
      err.status = 409;
      throw err;
    }
    const now = new Date();
    await chatMessages.updateOne(
      { threadId: tid, messageId: mid },
      {
        $set: {
          "reply.status": "pending",
          "reply.requestedAt": now,
        },
        $unset: {
          "reply.error": "",
          "reply.failedAt": "",
          "reply.claimedAt": "",
          "reply.runnerId": "",
          "reply.repliedAt": "",
          "reply.replyMessageId": "",
        },
      },
    );
    return {
      ok: true,
      threadId: tid,
      messageId: mid,
      reply: { status: "pending" },
    };
  }

  /**
   * Atomically claim the oldest phone user message awaiting a reply.
   * threadKind "desk" claims project-desk turns (desk runner); anything else
   * claims the rest (hub-runner), so the two never answer the same message.
   * @returns {object|null} claimed message doc or null
   */
  async function claimNextPendingReply({
    runnerId = HUB_RUNNER_DESK_ID,
    staleMs = REPLY_STALE_MS,
    threadKind = null,
  } = {}) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - (Number(staleMs) || REPLY_STALE_MS));
    const filter = {
      originKind: "phone",
      role: "user",
      threadKind: threadKind === "desk" ? "desk" : { $ne: "desk" },
      $and: [
        {
          $or: [
            { op: "message" },
            { op: { $exists: false } },
            { op: null },
          ],
        },
        {
          $or: [
            { "reply.status": "pending" },
            {
              "reply.status": "claimed",
              "reply.claimedAt": { $lt: staleBefore },
            },
          ],
        },
      ],
    };
    const doc = await chatMessages.findOneAndUpdate(
      filter,
      {
        $set: {
          "reply.status": "claimed",
          "reply.claimedAt": now,
          "reply.runnerId": String(runnerId || HUB_RUNNER_DESK_ID).slice(0, 128),
        },
        $inc: { "reply.attempts": 1 },
      },
      {
        sort: { "reply.requestedAt": 1, seq: 1 },
        returnDocument: "after",
      },
    );
    return doc || null;
  }

  /**
   * Last N non-deleted "message" ops for LLM context, seq ascending.
   * Applies edit ops that appear in the same recent window (simple model —
   * edits older than the window are ignored). Deletes in-window remove targets.
   */
  async function getThreadMessagesForContext(threadId, { limit = 40 } = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) return [];
    const lim = Math.min(200, Math.max(1, Number(limit) || 40));
    const window = Math.min(500, Math.max(lim * 5, lim));
    const recent = await chatMessages
      .find({ threadId: tid })
      .sort({ seq: -1 })
      .limit(window)
      .toArray();
    recent.reverse();
    const deleted = new Set();
    const edits = new Map();
    for (const r of recent) {
      const op = r.op || "message";
      if (op === "delete" && r.targetMessageId) deleted.add(r.targetMessageId);
      if (op === "edit" && r.targetMessageId) edits.set(r.targetMessageId, r.text);
    }
    const out = [];
    for (const r of recent) {
      const op = r.op || "message";
      if (op !== "message") continue;
      if (deleted.has(r.messageId)) continue;
      out.push({
        messageId: r.messageId,
        seq: r.seq,
        role: r.role,
        text: edits.has(r.messageId) ? edits.get(r.messageId) : r.text,
        ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
        ...(r.originKind ? { originKind: r.originKind } : {}),
      });
    }
    return out.slice(-lim);
  }

  async function completeReply({
    threadId,
    messageId,
    replyMessageId,
    model,
  } = {}) {
    const tid = String(threadId || "").trim();
    const mid = String(messageId || "").trim();
    const now = new Date();
    const doc = await chatMessages.findOneAndUpdate(
      { threadId: tid, messageId: mid, originKind: "phone" },
      {
        $set: {
          "reply.status": "replied",
          "reply.repliedAt": now,
          "reply.replyMessageId": String(replyMessageId || "").slice(0, 128),
          "reply.model":
            model != null ? String(model).slice(0, 128) : null,
        },
        $unset: {
          "reply.error": "",
          "reply.failedAt": "",
        },
      },
      { returnDocument: "after" },
    );
    if (!doc) {
      const err = new Error("message not found");
      err.status = 404;
      throw err;
    }
    return doc;
  }

  async function failReply({ threadId, messageId, error } = {}) {
    const tid = String(threadId || "").trim();
    const mid = String(messageId || "").trim();
    const now = new Date();
    const doc = await chatMessages.findOneAndUpdate(
      { threadId: tid, messageId: mid, originKind: "phone" },
      {
        $set: {
          "reply.status": "error",
          "reply.failedAt": now,
          "reply.error": sanitizePublicText(error, 200) || "error",
        },
      },
      { returnDocument: "after" },
    );
    if (!doc) {
      const err = new Error("message not found");
      err.status = 404;
      throw err;
    }
    return doc;
  }

  async function writeRunnerHeartbeat({
    runnerId = HUB_RUNNER_DESK_ID,
    status = "ok",
    detail,
    model,
  } = {}) {
    const now = new Date();
    const st = status === "error" ? "error" : "ok";
    await hubRunner.updateOne(
      { _id: "status" },
      {
        $set: {
          runnerId: String(runnerId || HUB_RUNNER_DESK_ID).slice(0, 128),
          status: st,
          detail: detail != null ? sanitizePublicText(detail, 200) : null,
          model: model != null ? String(model).slice(0, 128) : null,
          lastBeatAt: now,
        },
      },
      { upsert: true },
    );
    return getRunnerStatus();
  }

  /**
   * One portfolio snapshot per desk. A later push from another desk must not
   * erase rooms this desk already sent. Files stay an array because paths
   * contain dots.
   */
  async function putProjectSnapshot({ deskId, files, heroNames }) {
    const id = String(deskId || "current");
    const pushedAt = new Date();
    await projectSnapshot.replaceOne(
      { _id: id },
      { _id: id, deskId: id, pushedAt, files, heroNames },
      { upsert: true },
    );
    return { pushedAt: pushedAt.toISOString() };
  }

  async function getProjectSnapshot() {
    const docs = await projectSnapshot.find({}).toArray();
    if (!docs.length) return null;
    const files = new Map();
    const heroNames = {};
    const ordered = docs.sort(
      (a, b) => new Date(a.pushedAt || 0).getTime() - new Date(b.pushedAt || 0).getTime(),
    );
    let latest = ordered[ordered.length - 1];
    for (const doc of ordered) {
      for (const file of Array.isArray(doc.files) ? doc.files : []) {
        if (file?.path) files.set(file.path, file);
      }
      Object.assign(heroNames, doc.heroNames || {});
    }
    return {
      deskId: latest.deskId || null,
      pushedAt: latest.pushedAt instanceof Date ? latest.pushedAt.toISOString() : latest.pushedAt,
      files: [...files.values()],
      heroNames,
    };
  }

  /** Desk cockpit (header, roster, kanban, inbox, hub network) — one doc, replaced per push. */
  async function putCockpitSnapshot({ deskId, cockpit }) {
    const pushedAt = new Date();
    await cockpitSnapshot.replaceOne(
      { _id: "current" },
      { _id: "current", deskId, pushedAt, cockpit },
      { upsert: true },
    );
    return { pushedAt: pushedAt.toISOString() };
  }

  async function getCockpitSnapshot() {
    const doc = await cockpitSnapshot.findOne({ _id: "current" });
    if (!doc) return null;
    return {
      pushedAt: doc.pushedAt instanceof Date ? doc.pushedAt.toISOString() : doc.pushedAt,
      cockpit: doc.cockpit || {},
    };
  }

  async function putTreeSnapshot({ deskId, deskName, tree }) {
    const pushedAt = new Date();
    await treeSnapshots.replaceOne(
      { _id: deskId },
      { _id: deskId, deskId, deskName: deskName || null, pushedAt, tree },
      { upsert: true },
    );
    return { pushedAt: pushedAt.toISOString() };
  }

  /** Every desk's tree pushed within maxAgeMs (default 24h), newest first. */
  async function listTreeSnapshots({ maxAgeMs = 86400_000 } = {}) {
    const since = new Date(Date.now() - maxAgeMs);
    const docs = await treeSnapshots.find({ pushedAt: { $gte: since } }).sort({ pushedAt: -1 }).toArray();
    return docs.map((d) => ({
      deskId: d.deskId,
      deskName: d.deskName || null,
      pushedAt: d.pushedAt instanceof Date ? d.pushedAt.toISOString() : d.pushedAt,
      tree: d.tree || {},
    }));
  }

  /** The project's shared desk thread; created on first open, never owned by a phone. */
  async function ensureDeskThread({ slug, title }) {
    const projectSlug = normalizeProjectSlug(slug);
    if (!projectSlug) {
      const err = new Error("project required");
      err.status = 400;
      throw err;
    }
    const threadId = deskThreadId(projectSlug);
    const now = new Date();
    await chatThreads.updateOne(
      { threadId },
      {
        $setOnInsert: {
          threadId,
          kind: "desk",
          project: projectSlug,
          title: String(title || `${projectSlug} desk`).slice(0, 200),
          deskId: HUB_DESK_ID,
          createdByDeskId: HUB_DESK_ID,
          sharedWithDeskIds: [],
          lastSeq: 0,
          lastMessageAt: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await linkDeskThread(projectSlug, threadId);
    return { threadId, project: projectSlug };
  }

  async function getThread(threadId) {
    const t = await chatThreads.findOne({ threadId: String(threadId || "").trim() });
    if (!t) return null;
    return { threadId: t.threadId, title: t.title, project: t.project || null, kind: t.kind || null };
  }

  function isoOrNull(v) {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Sessions of a desk doc; docs from before multi-session wrap their one sessionId. */
  function deskSessionList(doc) {
    if (Array.isArray(doc.sessions)) {
      return doc.sessions
        .filter((s) => s?.sessionId)
        .map((s) => ({
          sessionId: s.sessionId,
          startedAt: isoOrNull(s.startedAt),
          startedBy: s.startedBy || null,
          lastMirroredId: s.lastMirroredId || null,
          lastActiveAt: isoOrNull(s.lastActiveAt || s.startedAt),
        }));
    }
    if (!doc.sessionId) return [];
    return [
      {
        sessionId: doc.sessionId,
        startedAt: isoOrNull(doc.sessionStartedAt || doc.updatedAt),
        startedBy: null,
        lastMirroredId: doc.lastMirroredId || null,
        lastActiveAt: isoOrNull(doc.updatedAt),
      },
    ];
  }

  function deskSessionView(doc) {
    if (!doc) return null;
    const sessions = deskSessionList(doc);
    const current = sessions.find((s) => s.sessionId === doc.sessionId) || null;
    return {
      slug: doc._id,
      sessionId: doc.sessionId || null,
      threadId: doc.threadId || deskThreadId(doc._id),
      lastMirroredId: current?.lastMirroredId ?? doc.lastMirroredId ?? null,
      sessionStartedAt: current?.startedAt || isoOrNull(doc.sessionStartedAt),
      sessions,
    };
  }

  async function getDeskSession(slug) {
    return deskSessionView(await deskSessions.findOne({ _id: String(slug) }));
  }

  /**
   * Projects with a session, each with the sessions the mirror should poll: the
   * current one plus any active in the last `recentMs` (a terminal may still sit
   * on the previous one until it reattaches).
   */
  async function listDeskSessions({ recentMs = 24 * 60 * 60_000 } = {}) {
    const since = Date.now() - recentMs;
    const rows = await deskSessions.find({ sessionId: { $nin: [null, ""] } }).toArray();
    return rows.map((doc) => {
      const view = deskSessionView(doc);
      view.sessions = view.sessions.filter(
        (s) => s.sessionId === view.sessionId || (s.lastActiveAt && Date.parse(s.lastActiveAt) >= since),
      );
      return view;
    });
  }

  /** Wrap a pre-multi-session doc's sessionId into sessions[] (no-op once migrated). */
  async function migrateDeskSessions(slug) {
    const doc = await deskSessions.findOne({ _id: String(slug) });
    if (!doc || Array.isArray(doc.sessions)) return;
    const sessions = deskSessionList(doc).map((s) => ({
      ...s,
      startedAt: s.startedAt ? new Date(s.startedAt) : new Date(),
      lastActiveAt: s.lastActiveAt ? new Date(s.lastActiveAt) : new Date(),
    }));
    await deskSessions.updateOne({ _id: String(slug), sessions: { $exists: false } }, { $set: { sessions } });
  }

  /** New session for the project's chat; it becomes current, older ones stay listed. */
  async function startDeskSession(slug, sessionId, startedBy = null) {
    const id = String(slug);
    await migrateDeskSessions(id);
    const now = new Date();
    await deskSessions.updateOne(
      { _id: id },
      {
        $set: { sessionId, lastMirroredId: null, sessionStartedAt: now, updatedAt: now },
        $push: {
          sessions: {
            sessionId,
            startedAt: now,
            startedBy: startedBy ? String(startedBy).slice(0, 80) : null,
            lastMirroredId: null,
            lastActiveAt: now,
          },
        },
        $setOnInsert: { threadId: deskThreadId(id) },
      },
      { upsert: true },
    );
    return { sessionId, startedAt: now.toISOString() };
  }

  /** Project whose chat already lists this OpenCode session (null if none). */
  async function deskSessionOwner(sessionId) {
    const doc = await deskSessions.findOne(
      { $or: [{ sessionId }, { "sessions.sessionId": sessionId }] },
      { projection: { _id: 1 } },
    );
    return doc?._id ?? null;
  }

  /**
   * Make an OpenCode session a terminal opened (or switched back to) the current
   * one: a known session keeps its mirror cursor, an unknown one is added fresh.
   */
  async function adoptDeskSession(slug, sessionId, startedBy = null) {
    const id = String(slug);
    await migrateDeskSessions(id);
    const doc = await deskSessions.findOne({ _id: id });
    const known = deskSessionList(doc || {}).find((s) => s.sessionId === sessionId);
    if (!known) return { ...(await startDeskSession(id, sessionId, startedBy)), resumed: false };
    const now = new Date();
    await deskSessions.updateOne(
      { _id: id, "sessions.sessionId": sessionId },
      {
        $set: {
          sessionId,
          lastMirroredId: known.lastMirroredId,
          sessionStartedAt: known.startedAt ? new Date(known.startedAt) : now,
          updatedAt: now,
          "sessions.$.lastActiveAt": now,
        },
      },
    );
    return { sessionId, startedAt: known.startedAt || now.toISOString(), resumed: true };
  }

  async function linkDeskThread(slug, threadId) {
    await deskSessions.updateOne(
      { _id: String(slug) },
      { $set: { threadId }, $setOnInsert: { sessionId: null, lastMirroredId: null } },
      { upsert: true },
    );
  }

  /** Record sessionId unless another caller got there first; returns the winner. */
  async function claimDeskSession(slug, sessionId) {
    await migrateDeskSessions(slug);
    const now = new Date();
    try {
      const doc = await deskSessions.findOneAndUpdate(
        { _id: String(slug), sessionId: { $in: [null, ""] } },
        {
          $set: { sessionId, lastMirroredId: null, sessionStartedAt: now, updatedAt: now },
          $push: { sessions: { sessionId, startedAt: now, startedBy: null, lastMirroredId: null, lastActiveAt: now } },
          $setOnInsert: { threadId: deskThreadId(slug) },
        },
        { upsert: true, returnDocument: "after" },
      );
      return doc?.sessionId || sessionId;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      const existing = await deskSessions.findOne({ _id: String(slug) });
      return existing?.sessionId || sessionId;
    }
  }

  /** Forget a session OpenCode no longer has (only if it is still the recorded one). */
  async function resetDeskSession(slug, sessionId) {
    await deskSessions.updateOne(
      { _id: String(slug), sessionId },
      { $set: { sessionId: null, lastMirroredId: null }, $pull: { sessions: { sessionId } } },
    );
  }

  /** Advance one session's mirror cursor (current or an older session of the chat). */
  async function setDeskMirrored(slug, sessionId, lastMirroredId) {
    const now = new Date();
    await deskSessions.updateOne(
      { _id: String(slug), "sessions.sessionId": sessionId },
      { $set: { "sessions.$.lastMirroredId": lastMirroredId, "sessions.$.lastActiveAt": now, updatedAt: now } },
    );
    await deskSessions.updateOne(
      { _id: String(slug), sessionId },
      { $set: { lastMirroredId, updatedAt: now } },
    );
  }

  async function getRunnerStatus() {
    const doc = await hubRunner.findOne({ _id: "status" });
    const lastBeatAt = doc?.lastBeatAt ? new Date(doc.lastBeatAt) : null;
    const age = lastBeatAt ? Date.now() - lastBeatAt.getTime() : Infinity;
    let status = "offline";
    if (lastBeatAt && age <= RUNNER_OFFLINE_MS) {
      status = doc.status === "error" ? "error" : "ok";
    }
    return {
      status,
      detail: doc?.detail != null ? String(doc.detail) : null,
      model: doc?.model ?? null,
      lastBeatAt: lastBeatAt ? lastBeatAt.toISOString() : null,
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
          createdByDeskId: deskId,
          sharedWithDeskIds: [],
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

  async function pullMessages({ threadId, after = 0, limit = 100, desk } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const afterSeq = Number(after) || 0;
    const filter = { seq: { $gt: afterSeq } };
    const tid = threadId ? String(threadId).trim() : null;

    if (desk && deskKindOf(desk) === "phone") {
      if (tid) {
        const ok = await canDeskAccessThread(desk, tid);
        if (!ok) {
          const err = new Error("thread not found");
          err.status = 404;
          throw err;
        }
        filter.threadId = tid;
      } else {
        const visible = await chatThreads
          .find(visibleThreadFilter(desk), { projection: { threadId: 1 } })
          .toArray();
        const ids = visible.map((t) => t.threadId);
        if (!ids.length) {
          return {
            ok: true,
            threadId: null,
            messages: [],
            nextAfter: afterSeq,
            hasMore: false,
          };
        }
        filter.threadId = { $in: ids };
      }
    } else if (tid) {
      filter.threadId = tid;
    }

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
      ...(r.originKind ? { originKind: r.originKind } : {}),
      ...(r.reply ? { reply: publicReply(r.reply) } : {}),
    }));

    const nextAfter = messages.length
      ? messages[messages.length - 1].seq
      : afterSeq;
    return {
      ok: true,
      threadId: tid || null,
      messages,
      nextAfter,
      hasMore: messages.length === lim,
    };
  }

  /**
   * @param {{ limit?: number, desk?: object, project?: string|null }} [opts]
   * project: pstack slug, or "none" for threads with no project.
   */
  async function listThreads({ limit = 100, desk, project } = {}) {
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const visible = visibleThreadFilter(desk);
    let filter = visible;
    if (project === "none") {
      filter = { $and: [visible, { project: { $in: [null] } }] };
    } else if (project != null && String(project).trim() !== "") {
      filter = { $and: [visible, { project: normalizeProjectSlug(project) }] };
    }
    const rows = await chatThreads
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(lim)
      .toArray();
    const isPhone = desk && deskKindOf(desk) === "phone";
    const isFullDesk = desk && deskKindOf(desk) === "desk";
    const callerId = desk?.deskId;
    return {
      ok: true,
      threads: rows.map((t) => {
        const sharedIds = Array.isArray(t.sharedWithDeskIds)
          ? t.sharedWithDeskIds
          : [];
        const base = {
          threadId: t.threadId,
          title: t.title,
          updatedAt:
            t.updatedAt instanceof Date
              ? t.updatedAt.toISOString()
              : t.updatedAt,
          deskId: t.deskId,
          project: t.project || null,
          ...(t.kind ? { kind: t.kind } : {}),
          lastSeq: t.lastSeq || 0,
          lastMessageAt:
            t.lastMessageAt instanceof Date
              ? t.lastMessageAt.toISOString()
              : t.lastMessageAt,
        };
        if (!desk) return base;
        if (isPhone) {
          const { deskId: _omitDeskId, ...phoneBase } = base;
          return {
            ...phoneBase,
            shared:
              t.createdByDeskId !== callerId && sharedIds.includes(callerId),
          };
        }
        if (isFullDesk) {
          return {
            ...base,
            createdByDeskId: t.createdByDeskId ?? null,
            sharedWithDeskIds: sharedIds,
          };
        }
        return base;
      }),
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
    mintWalletNonce,
    consumeWalletNonce,
    createWalletDesk,
    mintVerifyCode,
    consumeVerifyCode,
    setDeskWallet,
    listDesks,
    revokeDesk,
    pushMessages,
    sendMessage,
    retryReply,
    pullMessages,
    listThreads,
    shareThread,
    unshareThread,
    listThreadShares,
    canDeskAccessThread,
    visibleThreadFilter,
    claimNextPendingReply,
    getThreadMessagesForContext,
    completeReply,
    failReply,
    writeRunnerHeartbeat,
    getRunnerStatus,
    putProjectSnapshot,
    getProjectSnapshot,
    putCockpitSnapshot,
    getCockpitSnapshot,
    putTreeSnapshot,
    listTreeSnapshots,
    ensureDeskThread,
    getThread,
    getDeskSession,
    listDeskSessions,
    linkDeskThread,
    claimDeskSession,
    startDeskSession,
    adoptDeskSession,
    deskSessionOwner,
    resetDeskSession,
    setDeskMirrored,
    createSnapshot,
    getSnapshot,
    close,
    HUB_RUNNER_DESK_ID,
    REPLY_STALE_MS,
    RUNNER_OFFLINE_MS,
  };
}

export {
  HUB_RUNNER_DESK_ID,
  REPLY_STALE_MS,
  RUNNER_OFFLINE_MS,
  sanitizePublicText,
};
