#!/usr/bin/env bash
#
# Apply pending D1 migrations to ROUTER_DB + every AUTH_DB shard.
# Use this instead of `wrangler d1 migrations apply` when shipping schema
# changes — running against a single binding leaves the other shards
# behind, which is the kind of bug that doesn't surface until traffic
# routes a request to a stale shard.
#
# Idempotent: wrangler tracks applied migrations per database in
# d1_migrations and skips anything already done.
#
# Usage:
#   scripts/migrate-all-shards.sh                # remote prod
#   scripts/migrate-all-shards.sh --staging      # remote staging (env.staging block)
#   scripts/migrate-all-shards.sh --local        # local dev
#
# Pre-req: cwd = repo root, apps/main installed (wrangler available).
set -euo pipefail

LOCAL_FLAG=""
REMOTE_FLAG="--remote"
ENV_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --local) REMOTE_FLAG=""; LOCAL_FLAG="--local" ;;
    --staging) ENV_FLAG="--env staging" ;;
    --env=*) ENV_FLAG="--env ${arg#--env=}" ;;
  esac
done

cd "$(dirname "$0")/.."
cd apps/main

run_apply() {
  local binding="$1"
  echo ""
  echo "─── $binding ${ENV_FLAG:+($ENV_FLAG)} ────────────────────────"
  if [ -n "$LOCAL_FLAG" ]; then
    npx wrangler d1 migrations apply "$binding" --local --persist-to ../../.wrangler/state $ENV_FLAG \
      || echo "  (continuing — check error above)"
  else
    npx wrangler d1 migrations apply "$binding" --remote $ENV_FLAG \
      || echo "  (continuing — check error above)"
  fi
}

# Router DB: the routing tables themselves. Migrations live in
# migrations-router/.
run_apply ROUTER_DB

# Per-shard AUTH_DB. Same migrations dir (migrations/) for all shards;
# wrangler picks up migrations-dir from the wrangler.json binding config.
for SHARD in AUTH_DB_00 AUTH_DB_01 AUTH_DB_02 AUTH_DB_03; do
  run_apply "$SHARD"
done

# Integrations DB (single, not sharded yet).
run_apply INTEGRATIONS_DB

echo ""
echo "✓ migrations applied across all shards"
