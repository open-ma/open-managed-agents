#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Defaults
: "${OMA_API_URL:="http://localhost:8787"}"
: "${OMA_API_KEY:="test-key"}"

export OMA_API_URL OMA_API_KEY

echo "OMA Eval Runner"
echo "  API URL: $OMA_API_URL"
echo "  API Key: ${OMA_API_KEY:0:8}..."
echo ""

cd "$PROJECT_ROOT"
exec npx tsx test/eval/runner.ts "$@"
