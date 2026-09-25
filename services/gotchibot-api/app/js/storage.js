/**
 * IndexedDB kv store for desk credentials only.
 * NEVER store chat messages/bodies here (or in localStorage / Cache).
 */

const DB_NAME = "gotchibot-app";
const STORE = "kv";
const DESK_KEY = "desk";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB request failed"));
  });
}

/**
 * @returns {Promise<{deskId: string, deskToken: string, name: string, kind: string, pairedAt: string}|null>}
 */
export async function getDesk() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const val = await idbReq(store.get(DESK_KEY));
    return val && typeof val === "object" ? val : null;
  } finally {
    db.close();
  }
}

/**
 * @param {{deskId: string, deskToken: string, name: string, kind: string, pairedAt?: string}} desk
 */
export async function setDesk(desk) {
  const record = {
    deskId: String(desk.deskId),
    deskToken: String(desk.deskToken),
    name: String(desk.name ?? ""),
    kind: String(desk.kind ?? "phone"),
    pairedAt: desk.pairedAt || new Date().toISOString(),
  };
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await idbReq(store.put(record, DESK_KEY));
  } finally {
    db.close();
  }
  return record;
}

export async function clearDesk() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    await idbReq(store.delete(DESK_KEY));
  } finally {
    db.close();
  }
}
