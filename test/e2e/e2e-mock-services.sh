#!/usr/bin/env bash
# Mock-services smoke — exercises every endpoint on the deployed mock
# CF Worker (test/mocks/mock-server). Run after `wrangler deploy` in
# that directory to verify the worker is reachable and the per-bearer
# state machines behave correctly.
#
# Usage:
#   ./test/e2e/e2e-mock-services.sh [mock-base-url]
# Defaults to https://oma-mock-services.hrhrngxy.workers.dev

set -euo pipefail

MOCK="${1:-https://oma-mock-services.hrhrngxy.workers.dev}"
PASS=0; FAIL=0
# Remote preview/Workers endpoints must never hold a release lane forever.
# Keep the defaults short, while allowing a slower private compatible service
# to opt into a larger bounded window.
CURL=(
  curl
  --connect-timeout "${OMA_MOCK_CONNECT_TIMEOUT_S:-5}"
  --max-time "${OMA_MOCK_TIMEOUT_S:-30}"
  --retry "${OMA_MOCK_RETRIES:-2}"
  --retry-delay 1
  --retry-max-time "${OMA_MOCK_RETRY_MAX_TIME_S:-60}"
  --retry-all-errors
  -sS
)

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"; PASS=$((PASS+1))
  else
    echo "  ✗ $name — expected '$expected', got '$actual'"; FAIL=$((FAIL+1))
  fi
}

echo "═══ root ═══"
ROOT=$("${CURL[@]}" "$MOCK/")
check "root advertises service" "oma-mock-services" "$ROOT"

echo
echo "═══ OAuth: /authorize → 302 with code+state ═══"
LOC=$("${CURL[@]}" -o /dev/null -w "%{redirect_url}" "$MOCK/oauth/authorize?redirect_uri=https://example.com/cb&state=xyz")
check "redirect carries code"  "code=mock_code_" "$LOC"
check "redirect carries state" "state=xyz"       "$LOC"

echo
echo "═══ OAuth: /token authorization_code ═══"
T1=$("${CURL[@]}" "$MOCK/oauth/token" -X POST -d 'grant_type=authorization_code&code=mock_code_test&redirect_uri=https://example.com/cb')
check "issues access_token"  "access_token"  "$T1"
check "issues refresh_token" "refresh_token" "$T1"
check "Bearer type"          "Bearer"        "$T1"

echo
echo "═══ OAuth: /token refresh_token ═══"
T2=$("${CURL[@]}" "$MOCK/oauth/token" -X POST -d 'grant_type=refresh_token&refresh_token=mock_rt_abc')
check "refreshed access_token" "access_token" "$T2"
check "rotated refresh_token"  "refresh_token" "$T2"

echo
echo "═══ MCP: /ok always 200 ═══"
OK=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/ok/" -X POST -H 'authorization: Bearer at_ok' -d '{}')
check "200 ok scenario" "200" "$OK"

echo
echo "═══ MCP: /401-once flips after first call ═══"
BEARER="at_test_$(date +%s)"
C1=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/401-once/" -X POST -H "authorization: Bearer $BEARER" -d '{}')
check "first call 401" "401" "$C1"
C2=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/401-once/" -X POST -H "authorization: Bearer $BEARER" -d '{}')
check "second call 200" "200" "$C2"
# New bearer gets fresh 401 budget
NB="at_new_$(date +%s%N)"
C3=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/401-once/" -X POST -H "authorization: Bearer $NB" -d '{}')
check "new bearer fresh 401" "401" "$C3"

echo
echo "═══ MCP: /403-always always 403 ═══"
F1=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/403-always/" -X POST -H 'authorization: Bearer at_x' -d '{}')
F2=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/403-always/" -X POST -H 'authorization: Bearer at_x' -d '{}')
check "first call 403"  "403" "$F1"
check "second call 403" "403" "$F2"

echo
echo "═══ MCP: /expire/{ttl} 401s after ttl ═══"
EXP_BEARER="at_exp_$(date +%s%N)"
E1=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/expire/1/" -X POST -H "authorization: Bearer $EXP_BEARER" -d '{}')
check "within ttl 200" "200" "$E1"
sleep 2
E2=$("${CURL[@]}" -o /dev/null -w "%{http_code}" "$MOCK/mcp/expire/1/" -X POST -H "authorization: Bearer $EXP_BEARER" -d '{}')
check "after ttl 401"  "401" "$E2"

echo
echo "═══════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
