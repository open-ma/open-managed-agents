#!/usr/bin/env bash
# End-to-end test against a deployed (or wrangler dev --remote) worker.
# Usage: ./test/e2e.sh <BASE_URL> <API_KEY>
# Example: ./test/e2e.sh https://managed-agents.your-account.workers.dev your-api-key

set -euo pipefail

BASE_URL="${1:?Usage: $0 <BASE_URL> <API_KEY>}"
API_KEY="${2:?Usage: $0 <BASE_URL> <API_KEY>}"

PASS=0
FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"
    ((PASS++))
  else
    echo "  ✗ $name — expected '$expected', got '$actual'"
    ((FAIL++))
  fi
}

api() {
  curl -sS "$BASE_URL$1" \
    -H "x-api-key: $API_KEY" \
    -H "content-type: application/json" \
    "${@:2}"
}

echo "=== Health Check ==="
HEALTH=$(curl -sS "$BASE_URL/health")
check "health endpoint" '"ok"' "$HEALTH"

echo ""
echo "=== Auth ==="
NO_AUTH=$(curl -sS "$BASE_URL/v1/agents" -X POST -H "content-type: application/json" -d '{"name":"x","model":"x"}' -o /dev/null -w "%{http_code}")
check "rejects no API key" "401" "$NO_AUTH"

echo ""
echo "=== Create Agent ==="
AGENT=$(api /v1/agents -X POST -d '{
  "name": "E2E Test Agent",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful coding assistant. Keep responses brief.",
  "tools": [{"type": "agent_toolset_20260401"}]
}')
echo "  Response: $AGENT"
AGENT_ID=$(echo "$AGENT" | jq -r .id)
check "agent id prefix" "agent_" "$AGENT_ID"
check "agent name" "E2E Test Agent" "$AGENT"

echo ""
echo "=== Get Agent ==="
AGENT_GET=$(api "/v1/agents/$AGENT_ID")
check "get agent by id" "$AGENT_ID" "$AGENT_GET"

echo ""
echo "=== Create Environment ==="
ENV=$(api /v1/environments -X POST -d '{
  "name": "e2e-env",
  "config": {"type": "cloud", "networking": {"type": "unrestricted"}}
}')
echo "  Response: $ENV"
ENV_ID=$(echo "$ENV" | jq -r .id)
check "env id prefix" "env_" "$ENV_ID"

echo ""
echo "=== Create Session ==="
SESSION=$(api /v1/sessions -X POST -d "{
  \"agent\": \"$AGENT_ID\",
  \"environment_id\": \"$ENV_ID\",
  \"title\": \"E2E Test\"
}")
echo "  Response: $SESSION"
SESSION_ID=$(echo "$SESSION" | jq -r .id)
check "session id prefix" "sess_" "$SESSION_ID"
check "session status idle" "idle" "$SESSION"

echo ""
echo "=== Get Session ==="
SESSION_GET=$(api "/v1/sessions/$SESSION_ID")
check "get session" "$SESSION_ID" "$SESSION_GET"

echo ""
echo "=== Open SSE Stream (background) ==="
SSE_FILE=$(mktemp)
# Start SSE listener in background, collect events for up to 120s
curl -sS -N "$BASE_URL/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $API_KEY" \
  --max-time 120 > "$SSE_FILE" 2>/dev/null &
SSE_PID=$!
sleep 1

echo ""
echo "=== Post User Message ==="
POST_STATUS=$(api "/v1/sessions/$SESSION_ID/events" -X POST \
  -d '{
    "events": [{
      "type": "user.message",
      "content": [{"type": "text", "text": "Write a Python script that prints the first 5 fibonacci numbers and save it to /workspace/fib.py, then run it."}]
    }]
  }' -o /dev/null -w "%{http_code}")
check "post events returns 202" "202" "$POST_STATUS"

echo ""
echo "=== Waiting for agent response (up to 90s)... ==="
# Wait for session.status_idle to appear in SSE stream
TIMEOUT=90
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q "session.status_idle" "$SSE_FILE" 2>/dev/null; then
    break
  fi
  if grep -q "session.error" "$SSE_FILE" 2>/dev/null; then
    echo "  ! Agent error detected"
    break
  fi
  sleep 2
  ((ELAPSED+=2))
done

# Kill SSE listener
kill $SSE_PID 2>/dev/null || true
wait $SSE_PID 2>/dev/null || true

echo ""
echo "=== SSE Events Received ==="
cat "$SSE_FILE"

echo ""
echo "=== Verify SSE Events ==="
SSE_CONTENT=$(cat "$SSE_FILE")
check "received agent.message" "agent.message" "$SSE_CONTENT"
check "received agent.tool_use" "agent.tool_use" "$SSE_CONTENT"
check "received agent.tool_result" "agent.tool_result" "$SSE_CONTENT"
check "received session.status_idle" "session.status_idle" "$SSE_CONTENT"

# Also test the /events/stream alias
echo ""
echo "=== Test /events/stream alias ==="
STREAM_STATUS=$(curl -sS "$BASE_URL/v1/sessions/$SESSION_ID/events/stream" \
  -H "x-api-key: $API_KEY" \
  --max-time 3 -o /dev/null -w "%{http_code}" 2>/dev/null || echo "200")
check "stream alias returns 200" "200" "$STREAM_STATUS"

rm -f "$SSE_FILE"

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

[ $FAIL -eq 0 ] && exit 0 || exit 1
