# syntax=docker/dockerfile:1.7
#
# CFless OMA — Node-side single-process image.
#
# Build:
#   docker build -f apps/main-node/Dockerfile -t openma/main-node:dev .
# Run (standalone):
#   docker run --rm -p 8787:8787 \
#     -v $(pwd)/data:/app/data \
#     -e ANTHROPIC_API_KEY=sk-... \
#     openma/main-node:dev
# Run (compose): see docker-compose.cfless.yml at repo root.
#
# What's intentionally NOT here yet (Phase G+ work):
#   - Compiled JS bundle. We run via tsx in the container too — same toolchain
#     as `pnpm --filter main-node start`. Adds ~30MB tsx + slows cold start
#     by ~150ms vs a pre-bundled dist; trivial relative to LLM round-trips.
#   - Distroless / scratch base. node:22-slim is ~150MB, fine for a self-host
#     audience. Switch to distroless when packaging matters.

# ─── Stage 1: deps (and native compile) ────────────────────────────────────
FROM node:22-slim AS deps

# better-sqlite3 ships a prebuilt binary for common targets but on
# arm64-glibc-Linux it falls back to compiling from source. python3 +
# build-essential cover both.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace metadata. Copy first so a code-only change doesn't bust the
# pnpm install cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds.json ./
COPY apps/main-node/package.json apps/main-node/
COPY apps/main/package.json apps/main/
COPY apps/agent/package.json apps/agent/
COPY apps/integrations/package.json apps/integrations/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY packages packages

# Install workspace deps. --frozen-lockfile fails fast on lockfile drift.
# Build approval list at .pnpm-approve-builds.json covers better-sqlite3 +
# esbuild + workerd + the anthropic tokeniser.
RUN corepack enable \
  && pnpm install --frozen-lockfile

# Now bring in the source code (cache-busts only on src changes, not deps).
COPY apps/main-node apps/main-node
COPY apps/main apps/main
COPY apps/agent apps/agent
COPY tsconfig.json ./

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# tsx + better-sqlite3 native module both need basic runtime libs only.
# corepack is needed at runtime so `pnpm start` resolves; alternatively we
# could invoke tsx directly via node_modules/.bin but corepack matches the
# dev workflow exactly.
RUN corepack enable
WORKDIR /app

# Copy the whole monorepo from deps (includes node_modules, source, schemas).
# An optimisation pass would `pnpm deploy --prod` to a slim subtree; for the
# PoC this is the simplest correct copy.
COPY --from=deps /app /app

# /app/data holds the sqlite db + per-session sandbox workdirs. Mount a
# volume here in production so state survives container restarts.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/oma.db
ENV SANDBOX_WORKDIR=/app/data/sandboxes

EXPOSE 8787
USER node
WORKDIR /app/apps/main-node

# tsx is the entry. SIGTERM is handled by main-node/src/index.ts for
# graceful shutdown.
CMD ["pnpm", "start"]
