/**
 * Wallet sign-in for the Hub phone app (EIP-191 personal_sign).
 *
 * Same proof as the desk's scripts/wallet-connect.mjs: the wallet signs a
 * nonce message, Foundry `cast wallet verify` checks it. No npm crypto deps.
 * Only the Hub owner's wallet may sign in (config ownerWallet, else the Hub's
 * sessions/.wallet.json).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SIGNATURE_RE = /^0x[a-fA-F0-9]{130}$/;

export function isAddress(value) {
  return ADDRESS_RE.test(String(value ?? ""));
}

export function isSignature(value) {
  return SIGNATURE_RE.test(String(value ?? ""));
}

/**
 * The exact text the wallet signs. Host binds the signature to this Hub.
 * @param {{ nonce: string, host?: string|null, issuedAt: string }} input
 */
export function walletLoginMessage({ nonce, host, issuedAt }) {
  return [
    "GotchiBot Hub sign-in",
    `Host: ${host || "gotchibot-hub"}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

/**
 * Owner wallet: explicit config wins, else the Hub desk's connected wallet.
 * @param {{ ownerWallet?: string|null }} config
 * @param {string} root repo root on the Hub
 * @returns {string|null} lowercase address
 */
export function resolveOwnerWallet(config, root) {
  const explicit = config?.ownerWallet;
  if (explicit && isAddress(explicit)) return String(explicit).toLowerCase();
  try {
    const w = JSON.parse(readFileSync(join(root, "sessions/.wallet.json"), "utf8"));
    if (w?.address && isAddress(w.address)) return String(w.address).toLowerCase();
  } catch {
    /* no desk wallet on this Hub */
  }
  return null;
}

/** Foundry cast: CAST_BIN, then ~/.foundry/bin/cast, then PATH. */
export function resolveCastBin(env = process.env) {
  if (env.CAST_BIN) return env.CAST_BIN;
  const foundry = join(homedir(), ".foundry/bin/cast");
  if (existsSync(foundry)) return foundry;
  return "cast";
}

/**
 * @param {{ castBin?: string, timeoutMs?: number }} [opts]
 * @returns {(input: { address: string, message: string, signature: string }) => Promise<boolean>}
 */
export function createCastVerifier({ castBin = resolveCastBin(), timeoutMs = 10_000 } = {}) {
  return ({ address, message, signature }) =>
    new Promise((resolveVerify) => {
      execFile(
        castBin,
        ["wallet", "verify", "--address", String(address).toLowerCase(), message, signature],
        { timeout: timeoutMs },
        (err) => resolveVerify(!err),
      );
    });
}
