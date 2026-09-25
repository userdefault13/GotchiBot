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

export function listThreads(token, limit = 50) {
  const q = new URLSearchParams({ limit: String(limit) });
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

export function hubHealth() {
  return apiFetch("/health");
}
