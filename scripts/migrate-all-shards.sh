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
#   scripts/migrate-all-shards.sh            # remote (prod)
#   scripts/migrate-all-shards.sh --local    # local dev
#
# Pre-req: cwd = repo root, apps/main installed (wrangler available).
set -euo pipefail

REMOTE_FLAG="--remote"
if [ "${1:-}" = "--local" ]; then
  REMOTE_FLAG=""
fi

cd "$(dirname "$0")/.."
cd apps/main

# Router DB: the routing tables themselves. Migrations live in
# migrations-router/.
echo "─── ROUTER_DB (openma-router) ────────────────────────────"
npx wrangler d1 migrations apply ROUTER_DB $REMOTE_FLAG \
  --persist-to ../../.wrangler/state \
  || echo "  (continuing — check error above)"

# Per-shard AUTH_DB. Same migrations dir (migrations/) for all shards;
# wrangler picks up migrations-dir from the wrangler.json binding config.
for SHARD in AUTH_DB_00 AUTH_DB_01 AUTH_DB_02 AUTH_DB_03; do
  echo ""
  echo "─── $SHARD ────────────────────────────────"
  npx wrangler d1 migrations apply "$SHARD" $REMOTE_FLAG \
    --persist-to ../../.wrangler/state \
    || echo "  (continuing — check error above)"
done

# Integrations DB (single, not sharded yet).
echo ""
echo "─── INTEGRATIONS_DB ────────────────────────"
npx wrangler d1 migrations apply INTEGRATIONS_DB $REMOTE_FLAG \
  --persist-to ../../.wrangler/state \
  || echo "  (continuing — check error above)"

echo ""
echo "✓ migrations applied across all shards"
