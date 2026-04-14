#!/bin/bash
# Generate Dockerfile and wrangler.jsonc for a sandbox worker.
#
# Usage: ./generate.sh <env_id> <kv_id> [packages_json]

set -euo pipefail

ENV_ID="${1:?Usage: generate.sh <env_id> <kv_id> [packages_json]}"
KV_ID="${2:?Usage: generate.sh <env_id> <kv_id> [packages_json]}"
PACKAGES_JSON="${3:-{}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/build-${ENV_ID}"

mkdir -p "$OUT_DIR"

# --- Generate Dockerfile ---
# Start from the npm package Dockerfile (works on both arm64 and amd64)
# Find @cloudflare/sandbox — could be in root or local node_modules
SANDBOX_PKG="$SCRIPT_DIR/../../node_modules/@cloudflare/sandbox"
if [ ! -d "$SANDBOX_PKG" ]; then
  SANDBOX_PKG="$SCRIPT_DIR/node_modules/@cloudflare/sandbox"
fi
BASE_DOCKERFILE="$SANDBOX_PKG/Dockerfile"
cp "$BASE_DOCKERFILE" "$OUT_DIR/Dockerfile"
cp -r "$SANDBOX_PKG/container_src" "$OUT_DIR/container_src" 2>/dev/null || true

# Append package install commands to the Dockerfile
APT_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.apt // [] | join(" ")' 2>/dev/null || echo "")
PIP_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.pip // [] | join(" ")' 2>/dev/null || echo "")
NPM_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.npm // [] | join(" ")' 2>/dev/null || echo "")
CARGO_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.cargo // [] | join(" ")' 2>/dev/null || echo "")
GEM_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.gem // [] | join(" ")' 2>/dev/null || echo "")
GO_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.go // [] | join(" ")' 2>/dev/null || echo "")

{
  echo ""
  echo "# --- Custom packages ---"
  [ -n "$APT_PKGS" ] && echo "RUN apt-get update && apt-get install -y $APT_PKGS && rm -rf /var/lib/apt/lists/*"
  [ -n "$PIP_PKGS" ] && echo "RUN pip install uv && uv pip install --system $PIP_PKGS"
  [ -n "$NPM_PKGS" ] && echo "RUN npm install -g $NPM_PKGS"
  [ -n "$CARGO_PKGS" ] && echo "RUN cargo install $CARGO_PKGS"
  [ -n "$GEM_PKGS" ] && echo "RUN gem install $GEM_PKGS"
  [ -n "$GO_PKGS" ] && echo "RUN go install $GO_PKGS"
} >> "$OUT_DIR/Dockerfile"

# --- Generate wrangler.jsonc from template ---
sed -e "s/__ENV_ID__/${ENV_ID}/g" \
    -e "s/__KV_ID__/${KV_ID}/g" \
    "$SCRIPT_DIR/wrangler.template.jsonc" > "$OUT_DIR/wrangler.jsonc"

echo "Generated files in $OUT_DIR:"
echo "  - Dockerfile"
echo "  - wrangler.jsonc"
