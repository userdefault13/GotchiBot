# GotchiBot sub-agent sandbox — Linux box for new-project builds.
# No docker.sock. No host ~/Dev. Work lives on a bind-mounted /work volume.
FROM node:22-bookworm-slim

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# OpenCode CLI (Linux). Pin via OPENCODE_VERSION build-arg when needed.
ARG OPENCODE_VERSION=
RUN curl -fsSL https://opencode.ai/install | bash \
  && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && opencode --version || true

WORKDIR /work
ENV GOTCHIBOT_SANDBOX=1 \
    GOTCHIBOT_SKIP_ABRA=1 \
    HOME=/tmp/gotchibot-home \
    PATH="/usr/local/bin:/root/.opencode/bin:${PATH}"

# Abra vault is reached via host.docker.internal:7331 + ABRA_KEY (injected at up).
# Do not bake secrets into the image.
RUN mkdir -p /tmp/gotchibot-home /session /work \
  && printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'if [ -z "${ABRA_KEY:-}" ]; then echo "ABRA_KEY missing — secrets unavailable in sandbox" >&2; exit 2; fi' \
    'HOST="${ABRA_HOST:-host.docker.internal}"' \
    'curl -fsS -X POST "http://${HOST}:7331/secret" \' \
    '  -H "Authorization: Bearer ${ABRA_KEY}" \' \
    '  -H "Content-Type: application/json" \' \
    '  -d "{\"project\":\"${ABRA_PROJECT:-gotchibot}\",\"keys\":$1}"' \
    > /usr/local/bin/sandbox-abra-fetch \
  && chmod +x /usr/local/bin/sandbox-abra-fetch

CMD ["sleep", "infinity"]
