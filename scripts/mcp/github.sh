#!/usr/bin/env bash
# Official GitHub MCP (Docker). Token via abracadabra: gotchibot GOTCHIBOT_GITHUB_PAT
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${GITHUB_MCP_IMAGE:-ghcr.io/github/github-mcp-server}"
TOOLSETS="${GITHUB_TOOLSETS:-repos,issues,pull_requests}"

if [ "${GOTCHIBOT_GITHUB_MCP_INNER:-}" != 1 ] && command -v abra >/dev/null 2>&1; then
  exec env GOTCHIBOT_GITHUB_MCP_INNER=1 abra run gotchibot -- "$ROOT/scripts/mcp/github.sh" "$@"
fi

if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] && [ -n "${GOTCHIBOT_GITHUB_PAT:-}" ]; then
  export GITHUB_PERSONAL_ACCESS_TOKEN="$GOTCHIBOT_GITHUB_PAT"
fi
if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
  echo "github-mcp: missing GOTCHIBOT_GITHUB_PAT — store in abracadabra (project gotchibot)" >&2
  exit 1
fi

if ! command -v docker >/dev/null; then
  echo "github-mcp: docker required" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "github-mcp: docker daemon not running" >&2
  exit 1
fi

export GITHUB_TOOLSETS="$TOOLSETS"
exec docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN \
  -e GITHUB_TOOLSETS \
  "$IMAGE"
