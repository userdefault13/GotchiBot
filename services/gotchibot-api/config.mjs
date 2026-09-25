/**
 * Hub API config — env wins over sessions/.hub-api.json (install wizard).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const HUB_CONFIG_DEFAULT_PATH = resolve(ROOT, "sessions/.hub-api.json");

/**
 * @param {string} [path]
 * @returns {Record<string, unknown> | null}
 */
export function readHubApiConfig(path = HUB_CONFIG_DEFAULT_PATH) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} data
 * @param {string} [path]
 */
export function writeHubApiConfig(data, path = HUB_CONFIG_DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveApiConfig(env = process.env) {
  const configPath = env.GOTCHIBOT_HUB_CONFIG || HUB_CONFIG_DEFAULT_PATH;
  const file = readHubApiConfig(configPath) || {};

  const host = String(env.GOTCHIBOT_API_HOST || file.host || "127.0.0.1").trim() || "127.0.0.1";
  const portRaw = env.GOTCHIBOT_API_PORT ?? file.port ?? 8793;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`invalid GOTCHIBOT_API_PORT: ${portRaw}`);
  }
  const mongoUri = String(env.MONGODB_URI || file.mongoUri || "mongodb://127.0.0.1:27017").trim();
  const dbName = String(env.MONGO_DB_NAME || file.dbName || "GotchiBot").trim() || "GotchiBot";
  const ownerLoginRaw = env.GOTCHIBOT_HUB_OWNER_LOGIN ?? file.ownerLogin;
  const ownerLogin =
    ownerLoginRaw != null && String(ownerLoginRaw).trim()
      ? String(ownerLoginRaw).trim()
      : null;

  return {
    host,
    port,
    mongoUri,
    dbName,
    ownerLogin,
    configPath,
    tailscaleHost: file.tailscaleHost ? String(file.tailscaleHost) : null,
  };
}
