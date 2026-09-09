#!/usr/bin/env bash
# Repeatable beta/release gate for the public Managed Agents interfaces.
#
# This intentionally runs against a deployed endpoint. The product/runtime
# remains real; the LLM may be a deterministic Anthropic-compatible fixture.
# MCP fault/conformance is covered by the package chaos lanes and the fixture
# worker, not by silently substituting a fake API for the deployed control
# plane.
#
# Required:
#   OMA_E2E_BASE_URL       deployed main/console origin
#   OMA_E2E_API_KEY        temporary test key for the target tenant
#
# Recommended:
#   OMA_E2E_MOCK_MODEL_BASE_URL  mock-services /v1/messages origin
#
# Optional:
#   OMA_E2E_MODEL          real model-card id (only when no mock URL is used)
#   OMA_E2E_MOCK_SERVICES_BASE_URL  deployed OAuth/MCP fixture Worker
#   OMA_E2E_INPUT_MODEL_BASE_URL, OMA_E2E_MCP_URL,
#   OMA_E2E_REPO_URL, OMA_E2E_REPO_SHA, OMA_E2E_REPO_TOKEN
#                          complete mounted-input/MCP lane (all-or-none)
#   OMA_E2E_RUN_BRIDGE=1   opt-in destructive local bridge lifecycle lane
#
# Usage:
#   OMA_E2E_BASE_URL=... OMA_E2E_API_KEY=... \
#   OMA_E2E_MOCK_MODEL_BASE_URL=... pnpm test:e2e:release

set -euo pipefail

: "${OMA_E2E_BASE_URL:?OMA_E2E_BASE_URL is required}"
: "${OMA_E2E_API_KEY:?OMA_E2E_API_KEY is required}"

if [[ -z "${OMA_E2E_MOCK_MODEL_BASE_URL:-}" && -z "${OMA_E2E_MODEL:-}" ]]; then
  echo "release E2E requires OMA_E2E_MOCK_MODEL_BASE_URL or OMA_E2E_MODEL" >&2
  exit 2
fi

export OMA_E2E_RUN_TURN=1

echo "== Deterministic protocol + runtime chaos (mock LLM/MCP) =="
pnpm test:coverage:protocol
pnpm test:chaos:runtime

if [[ -n "${OMA_E2E_MOCK_SERVICES_BASE_URL:-}" ]]; then
  echo "== Mock-services Worker OAuth/MCP smoke =="
  bash test/e2e/e2e-mock-services.sh "$OMA_E2E_MOCK_SERVICES_BASE_URL"
fi

echo "== Managed Agents SDK + SSE =="
node test/e2e/managed-agents-sdk.mjs

input_lane_vars=(
  OMA_E2E_INPUT_MODEL_BASE_URL
  OMA_E2E_MCP_URL
  OMA_E2E_REPO_URL
  OMA_E2E_REPO_SHA
  OMA_E2E_REPO_TOKEN
)
configured_input_lane_vars=0
for name in "${input_lane_vars[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    configured_input_lane_vars=$((configured_input_lane_vars + 1))
  fi
done
if [[ "$configured_input_lane_vars" -eq "${#input_lane_vars[@]}" ]]; then
  echo "== Managed Files/Repo/Skill/Memory/MCP + durable output =="
  node test/e2e/managed-inputs-mcp.mjs
elif [[ "$configured_input_lane_vars" -eq 0 ]]; then
  echo "== Managed Files/Repo/Skill/Memory/MCP + durable output: NOT_RUN_NO_REPO_CREDENTIAL =="
else
  echo "managed input lane is partially configured; provide all of: ${input_lane_vars[*]}" >&2
  exit 2
fi

echo "== Deployed Console =="
pnpm exec playwright test test/e2e/deployed-console.spec.ts --config=playwright.config.ts

echo "== CLI API projection =="
OMA_BASE_URL="$OMA_E2E_BASE_URL" \
OMA_API_KEY="$OMA_E2E_API_KEY" \
  pnpm --filter @openma/cli exec tsx src/index.ts agents list --json >/dev/null

if [[ "${OMA_E2E_RUN_BRIDGE:-0}" == "1" ]]; then
  echo "== Opt-in CLI bridge lifecycle =="
  OMA_E2E_BRIDGE=1 pnpm exec playwright test test/e2e/bridge-setup-lifecycle.test.ts
fi

echo "release E2E gate passed"
