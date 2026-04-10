#!/bin/bash
# Local full-flow test: create environment → build image → start sandbox worker → callback
#
# Usage:
#   ./scripts/local-build-env.sh <env_name> [packages_json]
#
# Example:
#   ./scripts/local-build-env.sh python-dev '{"pip":["pandas","numpy"]}'
#   ./scripts/local-build-env.sh default

set -euo pipefail

MAIN_URL="${MAIN_URL:-http://localhost:8787}"
API_KEY="${API_KEY:-69eeafe2dfa45bbf34798894c206a3a655b18fd23e38bb21931346432c88ccbb}"
BUILD_SECRET="${BUILD_SECRET:-local-dev-secret}"
BASE_PORT="${BASE_PORT:-8790}"

ENV_NAME="${1:?Usage: local-build-env.sh <env_name> [packages_json]}"
PACKAGES_JSON="${2:-{}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Step 1: Create environment via API ==="
CONFIG="{\"type\":\"cloud\"}"
if [ "$PACKAGES_JSON" != "{}" ]; then
  CONFIG="{\"type\":\"cloud\",\"packages\":$PACKAGES_JSON}"
fi

ENV_RESPONSE=$(curl -sS -X POST "$MAIN_URL/v1/environments" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"$ENV_NAME\",\"config\":$CONFIG}")

ENV_ID=$(echo "$ENV_RESPONSE" | jq -r '.id')
echo "Environment created: $ENV_ID"
echo "$ENV_RESPONSE" | jq .

echo ""
echo "=== Step 2: Generate Dockerfile ==="
cd "$ROOT_DIR/sandbox-worker"
bash generate.sh "$ENV_ID" "5e49bdaec1884f5989037c86ece7b462" "$PACKAGES_JSON"
BUILD_DIR="$ROOT_DIR/sandbox-worker/build-${ENV_ID}"

echo ""
echo "=== Step 3: Docker build ==="
# Build the sandbox image locally
IMAGE_TAG="sandbox-${ENV_ID}:latest"
docker build -t "$IMAGE_TAG" "$BUILD_DIR"

echo ""
echo "=== Step 4: Find free port and update wrangler config ==="
# Find a free port starting from BASE_PORT
PORT=$BASE_PORT
while lsof -ti :"$PORT" >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done
echo "Using port: $PORT"

# Update wrangler config to use the locally built image
# (wrangler dev will use the local Docker image directly)
cat > "$BUILD_DIR/wrangler.jsonc" <<WRANGLER
{
  "name": "sandbox-${ENV_ID}",
  "main": "../index.ts",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "lite",
      "max_instances": 5
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "SESSION_DO", "class_name": "SessionDO" },
      { "name": "SANDBOX", "class_name": "Sandbox" }
    ]
  },
  "kv_namespaces": [
    { "binding": "CONFIG_KV", "id": "5e49bdaec1884f5989037c86ece7b462" }
  ],
  "r2_buckets": [
    { "binding": "WORKSPACE_BUCKET", "bucket_name": "managed-agents-workspace" }
  ],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO", "Sandbox"] }
  ],
  "limits": { "cpu_ms": 300000 },
  "observability": { "enabled": true }
}
WRANGLER

# Copy .dev.vars
cp "$ROOT_DIR/.dev.vars" "$BUILD_DIR/.dev.vars"

echo ""
echo "=== Step 5: Start sandbox worker ==="
cd "$BUILD_DIR"
npx wrangler dev --config wrangler.jsonc --port "$PORT" --persist-to "$ROOT_DIR/.wrangler/state" &
WRANGLER_PID=$!
echo "Sandbox worker PID: $WRANGLER_PID (port $PORT)"

# Wait for it to be ready
echo "Waiting for sandbox worker to start..."
for i in $(seq 1 60); do
  if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "Sandbox worker ready on port $PORT"
    break
  fi
  sleep 2
done

echo ""
echo "=== Step 6: Callback build-complete ==="
curl -sS -X POST "$MAIN_URL/v1/environments/$ENV_ID/build-complete" \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -H "x-build-secret: $BUILD_SECRET" \
  -d "{\"status\":\"ready\",\"sandbox_worker_url\":\"http://localhost:$PORT\"}" | jq .

echo ""
echo "=== Done ==="
echo "Environment: $ENV_ID (ready)"
echo "Sandbox worker: http://localhost:$PORT (PID $WRANGLER_PID)"
echo ""
echo "To test:"
echo "  curl -X POST $MAIN_URL/v1/sessions -H 'x-api-key: $API_KEY' -H 'Content-Type: application/json' -d '{\"agent\":\"<agent_id>\",\"environment_id\":\"$ENV_ID\"}'"
echo ""
echo "To stop: kill $WRANGLER_PID"

# Keep running
wait $WRANGLER_PID
