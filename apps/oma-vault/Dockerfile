# syntax=docker/dockerfile:1.7
#
# Self-host OMA — outbound credential injector sidecar.
#
# Reads vault credentials from the shared sqlite db (mounted at
# /app/data/oma.db, same path as oma-server) and exposes a mockttp HTTPS
# MITM proxy on port 14322 that injects matching headers. Sandbox traffic
# is routed through this via HTTPS_PROXY / NODE_EXTRA_CA_CERTS env vars
# wired from main-node's LocalSubprocessSandbox.setOutboundContext.
#
# Build:
#   docker build -f apps/oma-vault/Dockerfile -t openma/oma-vault:dev .
# Run (compose): see docker-compose.yml at repo root.

# ─── Stage 1: deps (and native compile) ────────────────────────────────────
FROM node:22-slim AS deps

# better-sqlite3 native build deps. Same recipe as main-node.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace metadata first — code-only changes don't bust the install cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds.json ./
COPY apps/oma-vault/package.json apps/oma-vault/
COPY apps/main-node/package.json apps/main-node/
COPY apps/main/package.json apps/main/
COPY apps/agent/package.json apps/agent/
COPY apps/integrations/package.json apps/integrations/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY packages packages

RUN corepack enable \
  && pnpm install --frozen-lockfile

# Now bring in source.
COPY apps/oma-vault apps/oma-vault
COPY tsconfig.json ./

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN corepack enable
WORKDIR /app

COPY --from=deps /app /app

# Shared volume mount point; oma-server writes the db here.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/oma.db
ENV OMA_VAULT_CA_DIR=/app/data/oma-vault-ca
ENV OMA_VAULT_PORT=14322

EXPOSE 14322
USER node
WORKDIR /app/apps/oma-vault

CMD ["pnpm", "start"]
