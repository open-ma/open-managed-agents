#!/bin/bash
# Deploy script: reads all environment bindings from KV,
# generates wrangler.jsonc with service bindings,
# uploads new versions, runs smoke test, then deploys.
#
# Usage:
#   ./scripts/deploy.sh              # full deploy (upload + deploy)
#   ./scripts/deploy.sh upload-only  # just upload versions, don't activate
#   ./scripts/deploy.sh deploy-only  # activate previously uploaded versions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

KV_ID="${KV_NAMESPACE_ID:-5e49bdaec1884f5989037c86ece7b462}"
MODE="${1:-full}"

echo "=== Step 1: Read service bindings from KV ==="
# Get all svcbind:* keys → sandbox worker names
BINDINGS_JSON=$(npx wrangler kv key list --namespace-id "$KV_ID" 2>/dev/null \
  | jq '[.[] | select(.name | startswith("svcbind:"))]' 2>/dev/null || echo "[]")

SERVICES="[]"
SANDBOX_WORKERS=()

for row in $(echo "$BINDINGS_JSON" | jq -r '.[].name'); do
  ENV_ID="${row#svcbind:}"
  WORKER_NAME=$(npx wrangler kv get "$row" --namespace-id "$KV_ID" --text 2>/dev/null || echo "")
  if [ -z "$WORKER_NAME" ]; then continue; fi

  BINDING_NAME="SANDBOX_$(echo "$ENV_ID" | tr '-' '_')"
  SERVICES=$(echo "$SERVICES" | jq \
    --arg b "$BINDING_NAME" --arg s "$WORKER_NAME" \
    '. + [{"binding": $b, "service": $s}]')
  SANDBOX_WORKERS+=("$WORKER_NAME")

  echo "  $BINDING_NAME → $WORKER_NAME"
done

echo "Found ${#SANDBOX_WORKERS[@]} sandbox worker(s)"

echo ""
echo "=== Step 2: Generate wrangler.jsonc with service bindings ==="
# Read base config, inject dynamic service bindings
# Keep static bindings (like SANDBOX_sandbox_default for local dev) and add dynamic ones
BASE_CONFIG=$(cat wrangler.jsonc | jq 'del(.services)')
FINAL_CONFIG=$(echo "$BASE_CONFIG" | jq --argjson svcs "$SERVICES" '. + {services: $svcs}')
echo "$FINAL_CONFIG" > wrangler.deploy.jsonc
echo "Generated wrangler.deploy.jsonc with ${#SANDBOX_WORKERS[@]} service bindings"

if [ "$MODE" = "deploy-only" ]; then
  echo ""
  echo "=== Step 6-7: Deploy versions ==="
  # Deploy sandbox workers first, then main worker
  for WORKER_NAME in "${SANDBOX_WORKERS[@]}"; do
    BUILD_DIR="sandbox-worker/build-${WORKER_NAME#sandbox-}"
    if [ -d "$BUILD_DIR" ]; then
      echo "Deploying $WORKER_NAME..."
      npx wrangler versions deploy --config "$BUILD_DIR/wrangler.jsonc" --yes &
    fi
  done
  wait

  echo "Deploying main worker..."
  npx wrangler versions deploy --config wrangler.deploy.jsonc --yes
  echo "=== Done ==="
  exit 0
fi

echo ""
echo "=== Step 3: Upload main worker version (not live yet) ==="
MAIN_VERSION=$(npx wrangler versions upload --config wrangler.deploy.jsonc 2>&1 | tee /dev/stderr | grep -oP 'Version ID: \K[^\s]+' || echo "")
echo "Main worker version: ${MAIN_VERSION:-uploaded}"

echo ""
echo "=== Step 4: Upload sandbox worker versions (parallel) ==="
for WORKER_NAME in "${SANDBOX_WORKERS[@]}"; do
  BUILD_DIR="sandbox-worker/build-${WORKER_NAME#sandbox-}"
  if [ -d "$BUILD_DIR" ]; then
    echo "Uploading $WORKER_NAME..."
    npx wrangler versions upload --config "$BUILD_DIR/wrangler.jsonc" &
  fi
done
wait
echo "All sandbox worker versions uploaded"

if [ "$MODE" = "upload-only" ]; then
  echo ""
  echo "=== Upload complete. Run './scripts/deploy.sh deploy-only' to activate. ==="
  exit 0
fi

echo ""
echo "=== Step 5: Smoke test ==="
echo "(Smoke test placeholder — add version override header tests here)"
# Example:
# curl -s -H "Cloudflare-Workers-Version-Overrides: managed-agents=\"$MAIN_VERSION\"" \
#   https://your-domain/health

echo ""
echo "=== Step 6: Deploy sandbox workers → 100% ==="
for WORKER_NAME in "${SANDBOX_WORKERS[@]}"; do
  BUILD_DIR="sandbox-worker/build-${WORKER_NAME#sandbox-}"
  if [ -d "$BUILD_DIR" ]; then
    echo "Deploying $WORKER_NAME..."
    npx wrangler versions deploy --config "$BUILD_DIR/wrangler.jsonc" --yes &
  fi
done
wait
echo "All sandbox workers deployed"

echo ""
echo "=== Step 7: Deploy main worker → 100% ==="
npx wrangler versions deploy --config wrangler.deploy.jsonc --yes
echo "Main worker deployed"

echo ""
echo "=== Done ==="
