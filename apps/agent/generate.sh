#!/bin/bash
# Generate Dockerfile and wrangler.jsonc for a per-environment sandbox worker.
#
# Usage: ./generate.sh <env_id> <kv_id> [packages_json]

set -euo pipefail

ENV_ID="${1:?Usage: generate.sh <env_id> <kv_id> [packages_json]}"
KV_ID="${2:?Usage: generate.sh <env_id> <kv_id> [packages_json]}"
PACKAGES_JSON="${3:-{}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/build-${ENV_ID}"

mkdir -p "$OUT_DIR"

# --- Generate Dockerfile from pre-built base image ---
# Base image includes: Python 3.12 (uv), Node 20, Go 1.22, Rust, GCC 13,
# ripgrep, jq, git, tmux, vim, pandas, numpy, pytest, ruff, etc.
# Only per-environment packages are added on top.
BASE_IMAGE="${OMA_SANDBOX_BASE_IMAGE:-ghcr.io/open-ma/sandbox-base:latest}"
cat > "$OUT_DIR/Dockerfile" <<DOCKERFILE
FROM ${BASE_IMAGE}
DOCKERFILE

# Parse packages and append install commands
APT_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.apt // [] | join(" ")' 2>/dev/null || echo "")
PIP_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.pip // [] | join(" ")' 2>/dev/null || echo "")
NPM_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.npm // [] | join(" ")' 2>/dev/null || echo "")
CARGO_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.cargo // [] | join(" ")' 2>/dev/null || echo "")
GEM_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.gem // [] | join(" ")' 2>/dev/null || echo "")
GO_PKGS=$(echo "$PACKAGES_JSON" | jq -r '.go // [] | join(" ")' 2>/dev/null || echo "")

# Collect apt prerequisites for package managers
APT_DEPS=""
[ -n "$CARGO_PKGS" ] && APT_DEPS="$APT_DEPS cargo"
[ -n "$GEM_PKGS" ] && APT_DEPS="$APT_DEPS ruby-full"
[ -n "$GO_PKGS" ] && APT_DEPS="$APT_DEPS golang"

ALL_APT="$(echo "$APT_DEPS $APT_PKGS" | xargs)"

{
  [ -n "$ALL_APT" ] && echo "RUN apt-get update && apt-get install -y $ALL_APT && rm -rf /var/lib/apt/lists/*"
  [ -n "$PIP_PKGS" ] && echo "RUN uv pip install $PIP_PKGS"
  [ -n "$NPM_PKGS" ] && echo "RUN npm install -g $NPM_PKGS"
  [ -n "$CARGO_PKGS" ] && echo "RUN cargo install $CARGO_PKGS"
  [ -n "$GEM_PKGS" ] && echo "RUN gem install $GEM_PKGS"
  [ -n "$GO_PKGS" ] && echo "RUN go install $GO_PKGS"
} >> "$OUT_DIR/Dockerfile"

# --- Generate wrangler.jsonc from template ---
sed -e "s/__ENV_ID__/${ENV_ID}/g" \
    -e "s/__KV_ID__/${KV_ID}/g" \
    "$SCRIPT_DIR/wrangler.template.jsonc" > "$OUT_DIR/wrangler.jsonc"

# --- Symlink source so wrangler can bundle the worker ---
ln -sf ../src "$OUT_DIR/src"
ln -sf ../../../node_modules "$OUT_DIR/node_modules"
ln -sf ../../../packages "$OUT_DIR/packages"

echo "Generated files in $OUT_DIR:"
echo "  - Dockerfile"
echo "  - wrangler.jsonc"
echo "  - src/ -> ../src"
