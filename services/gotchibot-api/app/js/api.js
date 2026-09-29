/**
 * Same-origin Hub API fetch wrapper for the phone PWA.
 * Hub root = location.origin; app lives at /app/.
 */

export class ApiError extends Error {
  /**
   * @param {"unpaired"|"not-found"|"offline"|string} kind
   * @param {number} status
   * @param {string} message
   * @param {unknown} [body]
   */
  constructor(kind, status, message, body) {
    super(message || kind);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

/** Called before throwing ApiError("verify") so the app can route to #/verify. */
let onVerifyRequired = null;
export function setVerifyRequiredHandler(fn) {
  onVerifyRequired = typeof fn === "function" ? fn : null;
}

/** Absolute URL under the Hub origin for a path starting with /. */
export function hubUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return new URL(p, location.origin).href;
}

/**
 * @param {string} path absolute path e.g. /api/gotchibot/hub/whoami
 * @param {{ token?: string|null, method?: string, body?: unknown, fetchFn?: typeof fetch }} [opts]
 */
export async function apiFetch(path, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const method = (opts.method || "GET").toUpperCase();
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
  };
  if (opts.token) {
    headers["X-GotchiBot-Desk-Token"] = String(opts.token);
  }
  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    cache: "no-store",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await fetchFn(hubUrl(path), init);
  } catch (err) {
    throw new ApiError("offline", 0, err?.message || "network error");
  }

  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    try {
      data = await res.text();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && data.error) ||
      (typeof data === "string" && data) ||
      res.statusText ||
      `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new ApiError("unpaired", 401, String(msg), data);
    }
    if (res.status === 404) {
      throw new ApiError("not-found", 404, String(msg), data);
    }
    if (res.status === 403 && data && typeof data === "object" && data.kind === "verify") {
      onVerifyRequired?.();
      throw new ApiError("verify", 403, String(msg), data);
    }
    throw new ApiError("http", res.status, String(msg), data);
  }

  return data;
}

export function claimPair({ code, name, kind = "phone" }) {
  return apiFetch("/api/gotchibot/hub/pair/claim", {
    method: "POST",
    body: { code, name, kind },
  });
}

export function whoami(token) {
  return apiFetch("/api/gotchibot/hub/whoami", { token });
}

/**
 * @param {string} token
 * @param {number} [limit]
 * @param {string|null} [project] pstack slug, "none" for chats with no project
 */
export function listThreads(token, limit = 50, project = null) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (project) q.set("project", project);
  return apiFetch(`/api/gotchibot/chats/threads?${q}`, { token });
}

export function pullMessages(token, { threadId, after = 0, limit = 500 }) {
  const q = new URLSearchParams({
    threadId: String(threadId),
    after: String(after),
    limit: String(limit),
  });
  return apiFetch(`/api/gotchibot/chats/pull?${q}`, { token });
}

/**
 * Phone send (new thread when threadId omitted).
 * @param {string} token
 * @param {{ threadId?: string, clientMessageId?: string, text: string, title?: string, project?: string }} body
 */
export function sendMessage(token, body) {
  /** @type {Record<string, unknown>} */
  const payload = { text: body.text };
  if (body.threadId != null && String(body.threadId).trim() !== "") {
    payload.threadId = String(body.threadId).trim();
  }
  if (body.clientMessageId) payload.clientMessageId = body.clientMessageId;
  if (body.title != null) payload.title = body.title;
  if (body.project) payload.project = body.project;
  return apiFetch("/api/gotchibot/chats/send", {
    method: "POST",
    token,
    body: payload,
  });
}

/**
 * Re-queue a phone message whose reply.status is error (or stale claimed).
 * @param {string} token
 * @param {{ threadId: string, messageId: string }} body
 */
export function retryReply(token, body) {
  return apiFetch("/api/gotchibot/chats/retry", {
    method: "POST",
    token,
    body: {
      threadId: body.threadId,
      messageId: body.messageId,
    },
  });
}

/** Hub-runner heartbeat status (any paired desk). */
export function runnerStatus(token) {
  return apiFetch("/api/gotchibot/hub/runner", { token });
}

export function hubHealth() {
  return apiFetch("/health");
}

/** Owner-wallet sign-in: fetch the message to sign. */
export function walletNonce() {
  return apiFetch("/api/gotchibot/hub/wallet/nonce", { method: "POST", body: {} });
}

/**
 * Verify the signature on the Hub. handoff:true returns a pairing code for the
 * home-screen app instead of a desk token for this browser.
 * @param {{ address: string, signature: string, nonce: string, name?: string, handoff?: boolean }} body
 */
export function walletLogin(body) {
  return apiFetch("/api/gotchibot/hub/wallet/login", { method: "POST", body });
}

/** Paired phone asks for a one-time link to open inside MetaMask. */
export function walletVerifyRequest(token) {
  return apiFetch("/api/gotchibot/hub/wallet/verify-request", { method: "POST", token, body: {} });
}

/**
 * Inside the wallet browser: bind the owner wallet to the phone behind `code`.
 * @param {{ code: string, address: string, signature: string, nonce: string }} body
 */
export function walletVerify(body) {
  return apiFetch("/api/gotchibot/hub/wallet/verify", { method: "POST", body });
}

/** Desk cockpit snapshot (header, roster, kanban, inbox, hub network). */
export function getCockpit(token) {
  return apiFetch("/api/gotchibot/cockpit", { token });
}

export function listProjects(token) {
  return apiFetch("/api/gotchibot/projects", { token });
}

export function getProject(token, slug) {
  return apiFetch(`/api/gotchibot/projects/${encodeURIComponent(slug)}`, { token });
}

/** The project's shared desk thread (same conversation on every device). */
export function getProjectDesk(token, slug) {
  return apiFetch(`/api/gotchibot/projects/${encodeURIComponent(slug)}/desk`, { token });
}

/**
 * Hero avatar SVG as a blob: URL (img tags can't send the desk token header).
 * @returns {Promise<string|null>}
 */
export async function avatarObjectUrl(token, heroId) {
  let res;
  try {
    res = await fetch(hubUrl(`/api/gotchibot/avatars/${encodeURIComponent(heroId)}.svg`), {
      headers: { "X-GotchiBot-Desk-Token": String(token) },
      cache: "default",
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
