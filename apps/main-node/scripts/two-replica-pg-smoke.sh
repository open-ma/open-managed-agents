#!/usr/bin/env bash
# Two-replica PG smoke test for main-node.
#
# Spawns two main-node processes against the same Postgres + the same
# MEMORY_BLOB_DIR. Verifies that POST /v1/sessions/:id/_test_emit on
# replica A reaches an SSE client connected to replica B (i.e. the
# PG LISTEN/NOTIFY-backed EventStreamHub fans out across processes).
#
# Prereqs (host-side):
#   docker run --rm -d --name oma-pg-smoke \
#     -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma -e POSTGRES_DB=oma \
#     -p 5433:5432 postgres:16-alpine
#   pnpm install   # main-node deps incl. tsx + postgres
#   jq             # for parsing /v1/sessions response
#
# Usage:
#   apps/main-node/scripts/two-replica-pg-smoke.sh
#
# Tunables:
#   PG_URL    — defaults to postgres://oma:oma@localhost:5433/oma
#   WORK_DIR  — defaults to /tmp/oma-pg-2rep
#   PORT_A / PORT_B — defaults 18081 / 18082

set -euo pipefail
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
PG_URL="${PG_URL:-postgres://oma:oma@localhost:5433/oma}"
WORK_DIR="${WORK_DIR:-/tmp/oma-pg-2rep}"
PORT_A="${PORT_A:-18081}"
PORT_B="${PORT_B:-18082}"

DATA_A="$WORK_DIR/dataA"
DATA_B="$WORK_DIR/dataB"
MEM="$WORK_DIR/memshared"
mkdir -p "$DATA_A" "$DATA_B" "$MEM"

# Wipe shared PG state so the script is idempotent. Uses docker exec
# against the smoke postgres container so the host doesn't need psql.
docker exec oma-pg-smoke psql -U oma -d oma -c \
  "TRUNCATE session_events, session_streams, sessions RESTART IDENTITY" \
  >/dev/null 2>&1 || true

cd "$HERE"
TSX="apps/main-node/node_modules/.bin/tsx"

env DATABASE_URL="$PG_URL" AUTH_DISABLED=1 MEMORY_BLOB_DIR="$MEM" \
  BETTER_AUTH_SECRET=test-secret-only-for-smoke \
  PORT="$PORT_A" SANDBOX_WORKDIR="$DATA_A/sandboxes" AUTH_DATABASE_PATH="$DATA_A/auth.db" \
  "$TSX" apps/main-node/src/index.ts > "$WORK_DIR/A.log" 2>&1 &
PID_A=$!
env DATABASE_URL="$PG_URL" AUTH_DISABLED=1 MEMORY_BLOB_DIR="$MEM" \
  BETTER_AUTH_SECRET=test-secret-only-for-smoke \
  PORT="$PORT_B" SANDBOX_WORKDIR="$DATA_B/sandboxes" AUTH_DATABASE_PATH="$DATA_B/auth.db" \
  "$TSX" apps/main-node/src/index.ts > "$WORK_DIR/B.log" 2>&1 &
PID_B=$!
trap 'kill -9 $PID_A $PID_B ${PID_SSE:-} 2>/dev/null || true' EXIT

for url in "http://localhost:$PORT_A/health" "http://localhost:$PORT_B/health"; do
  for i in $(seq 1 60); do
    curl -sf "$url" >/dev/null && break
    sleep 0.5
  done
done

SID=$(curl -sf -X POST "http://localhost:$PORT_A/v1/sessions" \
  -H 'content-type: application/json' -d '{}' | jq -r .id)
echo "session: $SID"

curl -sN "http://localhost:$PORT_B/v1/sessions/$SID/events/stream" \
  > "$WORK_DIR/sse_B.log" 2>&1 &
PID_SSE=$!
sleep 0.4

T0=$(($(date +%s%N)/1000000))
curl -sf -X POST "http://localhost:$PORT_A/v1/sessions/$SID/_test_emit" \
  -H 'content-type: application/json' -d '{"text":"hello-from-A"}' >/dev/null

DEADLINE=$((T0 + 2000))
GOT_AT=
while [ "$(($(date +%s%N)/1000000))" -lt "$DEADLINE" ]; do
  if grep -q "hello-from-A" "$WORK_DIR/sse_B.log"; then
    GOT_AT=$(($(date +%s%N)/1000000))
    break
  fi
  sleep 0.01
done

if [ -z "$GOT_AT" ]; then
  echo "FAIL: SSE on replica B did not see event from A within 2s"
  echo "--- B log tail ---"; tail -30 "$WORK_DIR/B.log"
  echo "--- SSE B output ---"; cat "$WORK_DIR/sse_B.log"
  exit 1
fi
echo "OK: replica A -> replica B SSE latency = $((GOT_AT - T0))ms"
cat "$WORK_DIR/sse_B.log"
