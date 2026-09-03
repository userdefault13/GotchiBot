#!/usr/bin/env bash
# Runs ON the Hub (iMac). Invoked by scripts/hub-ops.mjs over SSH.
# Do not call from Desk without SSH/abra — use hub-ops.mjs / gotchibot hub …
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${PATH}"

ACTION="${1:-doctor}"
TIMEOUT="${2:-90}"
WAIT="${3:-1}"

OC_DIR=""
for d in "$HOME/Dev/openclaw" "$HOME/dev/openclaw" "/Users/juliuswong/Dev/openclaw"; do
  if [ -f "$d/docker-compose.yml" ]; then OC_DIR="$d"; break; fi
done

compose() {
  if [ -z "$OC_DIR" ]; then
    echo "openclaw compose dir not found" >&2
    return 1
  fi
  cd "$OC_DIR"
  if [ -f docker-compose.extra.yml ]; then
    docker compose -f docker-compose.yml -f docker-compose.extra.yml "$@"
  else
    docker compose "$@"
  fi
}

gateway_name() {
  docker ps -a --filter name=openclaw.*gateway --format '{{.Names}}' | head -1
}

health_local() {
  curl -sf --max-time 5 http://127.0.0.1:18789/healthz >/dev/null 2>&1
}

fix_plugins() {
  local c
  c="$(gateway_name)"
  [ -n "$c" ] || return 0
  # Quarantine orphan npm plugin trees that force capability consent and block ready.
  mkdir -p "$HOME/.openclaw/npm/projects-disabled" 2>/dev/null || true
  for d in openclaw-opencode-provider-641bb4636d openclaw-perplexity-plugin-9e59921123; do
    if [ -d "$HOME/.openclaw/npm/projects/$d" ]; then
      mv "$HOME/.openclaw/npm/projects/$d" "$HOME/.openclaw/npm/projects-disabled/" 2>/dev/null || true
    fi
  done
  # Repair clobbered / double-written JSON (gateway.mode missing).
  if [ -f "$HOME/.openclaw/openclaw.json" ]; then
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.openclaw/openclaw.json","utf8"))' 2>/dev/null; then
      if [ -f "$HOME/.openclaw/openclaw.json.bak" ]; then
        cp "$HOME/.openclaw/openclaw.json.bak" "$HOME/.openclaw/openclaw.json"
        echo "restored openclaw.json from .bak" >&2
      elif [ -f "$HOME/.openclaw/openclaw.json.last-good" ]; then
        cp "$HOME/.openclaw/openclaw.json.last-good" "$HOME/.openclaw/openclaw.json"
        echo "restored openclaw.json from .last-good" >&2
      fi
    fi
    node -e '
const fs=require("fs");
const p=process.env.HOME+"/.openclaw/openclaw.json";
const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.gateway=c.gateway||{};
c.gateway.mode="local";
c.gateway.bind=c.gateway.bind||"lan";
c.gateway.http=c.gateway.http||{};
c.gateway.http.endpoints=c.gateway.http.endpoints||{};
c.gateway.http.endpoints.chatCompletions={enabled:true};
c.gateway.http.endpoints.responses={enabled:true};
c.plugins={
  allow:["slack","opencode-go"],
  entries:{
    slack:{enabled:true},
    "opencode-go":{enabled:true},
  },
};
delete c.plugins.entries.opencode;
delete c.plugins.entries.perplexity;
fs.writeFileSync(p, JSON.stringify(c,null,2)+String.fromCharCode(10));
console.log("gateway.mode=local plugins patched (no perplexity)");
' 2>/dev/null || true
  fi
}

wait_health() {
  local deadline=$(($(date +%s) + TIMEOUT))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if health_local; then
      echo ok
      return 0
    fi
    sleep 2
  done
  echo "gateway healthz still failing after ${TIMEOUT}s" >&2
  local c
  c="$(gateway_name)"
  [ -n "$c" ] && docker logs "$c" --tail 40 >&2 || true
  return 1
}

case "$ACTION" in
  doctor)
    NAME="$(gateway_name || true)"
    STATUS="missing"
    [ -n "$NAME" ] && STATUS="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$NAME" 2>/dev/null || echo unknown)"
    HEALTH=0
    health_local && HEALTH=1
    printf '{"container":"%s","status":"%s","healthz":%s,"ocDir":"%s"}\n' \
      "${NAME:-}" "$STATUS" "$HEALTH" "${OC_DIR:-}"
    if [ "$HEALTH" != 1 ]; then
      echo "--- last logs ---" >&2
      [ -n "$NAME" ] && docker logs "$NAME" --tail 30 >&2 || true
      exit 1
    fi
    ;;
  restart-gateway)
    fix_plugins || true
    # Drop stale gateway locks left by crash loops / recreate races.
    rm -f "$HOME/.openclaw/tmp/openclaw-"*/gateway*.lock* 2>/dev/null || true
    if [ -n "$OC_DIR" ]; then
      compose stop openclaw-gateway >/dev/null 2>&1 || true
      sleep 1
      rm -f "$HOME/.openclaw/tmp/openclaw-"*/gateway*.lock* 2>/dev/null || true
      compose up -d --force-recreate openclaw-gateway
    else
      NAME="$(gateway_name)"
      [ -n "$NAME" ] || { echo "no openclaw gateway container" >&2; exit 1; }
      docker stop "$NAME" >/dev/null 2>&1 || true
      sleep 1
      rm -f "$HOME/.openclaw/tmp/openclaw-"*/gateway*.lock* 2>/dev/null || true
      docker start "$NAME"
    fi
    echo "restarted openclaw-gateway"
    if [ "$WAIT" = "1" ]; then
      wait_health
    fi
    printf '{"ok":true,"action":"restart-gateway","healthz":%s}\n' "$(health_local && echo 1 || echo 0)"
    ;;
  *)
    echo "usage: hub-ops-remote.sh doctor|restart-gateway [timeout] [wait 0|1]" >&2
    exit 2
    ;;
esac
