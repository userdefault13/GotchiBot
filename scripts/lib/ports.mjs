/**
 * Known local ports for GotchiBot desk / Hub features.
 * Hub API defaults stay on 8793; live Hub often binds 8794 — never reuse either
 * as another feature's default.
 */
export const PORTS = Object.freeze({
  /** Hub API default (services/gotchibot-api/config.mjs, templates CDN). */
  HUB_API_DEFAULT: 8793,
  /** Reserved: live Hub host often runs the API here — never another feature default. */
  HUB_API_LIVE: 8794,
  /** GOTCHIBOT_INFRA_SIGN_PORT default (scripts/infra-token.mjs). */
  INFRA_SIGN: 8789,
  /** GOTCHIBOT_HUB_SIGN_PORT default (scripts/hub.mjs). */
  HUB_SIGN: 8790,
  /** Cartridge sim listen port. */
  CARTRIDGE_SIM: 8791,
  /** TRADER_WEBHOOK_PORT default (scripts/trader-webhook.mjs). */
  TRADER_WEBHOOK: 8792,
  /** GOTCHIBOT_CHECKPOINT_SIGN_PORT default (scripts/chat-checkpoint-onchain.mjs). */
  CHECKPOINT_SIGN: 8796,
  /** default for GOTCHIBOT_HOST_ARTIFACT_PORT (scripts/host-network.mjs) — must not be 8794 */
  HOST_ARTIFACT: 8797,
});

/** Ports reserved for Hub API (default + live). Other features must not default to these. */
export const RESERVED_HUB_PORTS = Object.freeze([
  PORTS.HUB_API_DEFAULT,
  PORTS.HUB_API_LIVE,
]);
