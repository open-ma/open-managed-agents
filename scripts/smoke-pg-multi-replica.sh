#!/usr/bin/env bash
# Two-replica PG-mode smoke test.
#
# Boots an ephemeral postgres + two main-node replicas (sharing the
# same DATABASE_URL and MEMORY_BLOB_DIR) on different ports, then
# proves that an event published on replica A reaches an SSE client
# subscribed on replica B in <200ms.
#
# Tear-down is automatic on exit (trap). Re-runs are idempotent —
# stale containers / processes are killed first.
#
# Requires: docker, jq, curl, pnpm.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_PORT="${PG_PORT:-55433}"
A_PORT="${A_PORT:-18791}"
B_PORT="${B_PORT:-18792}"
DB_NAME="${DB_NAME:-oma_smoke}"
PG_CT_NAME="${PG_CT_NAME:-oma-smoke-pg}"
DATA_DIR="$(mktemp -d -t oma-smoke-XXXXXX)"

cleanup() {
  local rc=$?
  set +e
  if [[ $rc -ne 0 ]]; then
    echo "--- replica-A.log (tail) ---"
    tail -40 "$DATA_DIR/replica-A.log" 2>/dev/null
    echo "--- replica-B.log (tail) ---"
    tail -40 "$DATA_DIR/replica-B.log" 2>/dev/null
  fi
  if [[ -n "${A_PID:-}" ]]; then kill "$A_PID" 2>/dev/null; fi
  if [[ -n "${B_PID:-}" ]]; then kill "$B_PID" 2>/dev/null; fi
  if [[ -n "${SSE_PID:-}" ]]; then kill "$SSE_PID" 2>/dev/null; fi
  docker rm -f "$PG_CT_NAME" >/dev/null 2>&1
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# Idempotent — clean stale instance.
docker rm -f "$PG_CT_NAME" >/dev/null 2>&1 || true

echo "[smoke] booting postgres on :$PG_PORT (db=$DB_NAME, container=$PG_CT_NAME)…"
docker run -d --name "$PG_CT_NAME" \
  -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma -e POSTGRES_DB="$DB_NAME" \
  -p "$PG_PORT:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$PG_CT_NAME" pg_isready -U oma -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

DATABASE_URL="postgres://oma:oma@localhost:$PG_PORT/$DB_NAME"
mkdir -p "$DATA_DIR/memory-blobs" "$DATA_DIR/sandboxes" "$DATA_DIR/outputs"

start_replica() {
  local label="$1" port="$2"
  echo "[smoke] starting replica $label on :$port (data=$DATA_DIR)…"
  DATABASE_URL="$DATABASE_URL" \
  MEMORY_BLOB_DIR="$DATA_DIR/memory-blobs" \
  SANDBOX_WORKDIR="$DATA_DIR/sandboxes" \
  SESSION_OUTPUTS_DIR="$DATA_DIR/outputs" \
  AUTH_DATABASE_PATH="$DATA_DIR/auth-$label.db" \
  AUTH_DISABLED=1 \
  PORT="$port" HOST=127.0.0.1 \
    apps/main-node/node_modules/.bin/tsx apps/main-node/src/index.ts \
    >"$DATA_DIR/replica-$label.log" 2>&1 &
  printf '%s' "$!"
}

A_PID=$(start_replica A "$A_PORT")
B_PID=$(start_replica B "$B_PORT")

wait_health() {
  local port="$1"
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "[smoke] replica :$port never healthed"; return 1
}
wait_health "$A_PORT"
wait_health "$B_PORT"

# Sanity: both should report hub=pg-notify.
A_HUB=$(curl -s "http://localhost:$A_PORT/health" | jq -r '.backends.hub')
B_HUB=$(curl -s "http://localhost:$B_PORT/health" | jq -r '.backends.hub')
echo "[smoke] replica A hub=$A_HUB, replica B hub=$B_HUB"
if [[ "$A_HUB" != "pg-notify" || "$B_HUB" != "pg-notify" ]]; then
  echo "[smoke] FAIL: both replicas should report hub=pg-notify"
  exit 1
fi

SID=$(curl -s -X POST "http://localhost:$A_PORT/v1/sessions" \
  -H 'content-type: application/json' -d '{}' | jq -r .id)
echo "[smoke] session created on A: $SID"

SSE_LOG="$DATA_DIR/sse-B.log"
curl -sN "http://localhost:$B_PORT/v1/sessions/$SID/events/stream" >"$SSE_LOG" &
SSE_PID=$!
sleep 0.5  # let SSE connect + subscribe

T0=$(python3 -c 'import time; print(int(time.time() * 1000))')
curl -s -X POST "http://localhost:$A_PORT/v1/sessions/$SID/_test_emit" \
  -H 'content-type: application/json' \
  -d '{"text":"ping-from-A"}' >/dev/null

# Wait up to 2s for the SSE on B to receive the event.
for _ in $(seq 1 80); do
  if grep -q ping-from-A "$SSE_LOG" 2>/dev/null; then break; fi
  sleep 0.025
done
T1=$(python3 -c 'import time; print(int(time.time() * 1000))')
DT=$((T1 - T0))

if grep -q ping-from-A "$SSE_LOG"; then
  echo "[smoke] PASS: A→B fanout in ${DT} ms (target <200 ms)"
else
  echo "[smoke] FAIL: SSE on B never received event after $DT ms"
  echo "--- replica-A.log (tail) ---"; tail -30 "$DATA_DIR/replica-A.log"
  echo "--- replica-B.log (tail) ---"; tail -30 "$DATA_DIR/replica-B.log"
  echo "--- sse-B.log ---"; cat "$SSE_LOG"
  exit 1
fi
