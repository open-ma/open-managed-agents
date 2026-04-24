#!/usr/bin/env bash
# Real e2e test against wrangler dev.
# Usage: ./test/e2e-local.sh [BASE_URL]
# Defaults to http://localhost:8787

set -uo pipefail

BASE="${1:-http://localhost:8787}"
KEY="dev-test-key-change-me"
PASS=0; FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"; ((++PASS))
  else
    echo "  ✗ $name — expected '$expected' in '$actual'"; ((++FAIL))
  fi
}

api() {
  curl -sS "$BASE$1" -H "x-api-key: $KEY" -H "content-type: application/json" "${@:2}"
}

echo "=== 1. Health ==="
HEALTH=$(curl -sS "$BASE/health")
check "health" '"ok"' "$HEALTH"

echo ""
echo "=== 2. Create Agent ==="
AGENT=$(api /v1/agents -X POST -d '{
  "name":"E2E Agent",
  "model":"claude-sonnet-4-6",
  "system":"You are a helpful assistant. Keep responses very short (1-2 sentences).",
  "tools":[{"type":"agent_toolset_20260401"}]
}')
echo "  $AGENT" | head -c 200
echo ""
AGENT_ID=$(echo "$AGENT" | jq -r .id)
check "agent created" "agent_" "$AGENT_ID"

echo ""
echo "=== 3. Create Environment ==="
ENV=$(api /v1/environments -X POST -d '{"name":"e2e-env","config":{"type":"cloud"}}')
ENV_ID=$(echo "$ENV" | jq -r .id)
check "env created" "env_" "$ENV_ID"

echo ""
echo "=== 4. Create Session ==="
SESSION=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"E2E Test\"}")
echo "  $SESSION" | head -c 200
echo ""
SESSION_ID=$(echo "$SESSION" | jq -r .id)
check "session created" "sess_" "$SESSION_ID"

echo ""
echo "=== 5. Open SSE (background) ==="
SSE_FILE=$(mktemp)
curl -sS -N "$BASE/v1/sessions/$SESSION_ID/events" \
  -H "x-api-key: $KEY" -H "Accept: text/event-stream" \
  --max-time 90 > "$SSE_FILE" 2>/dev/null &
SSE_PID=$!
sleep 1

echo ""
echo "=== 6. Send Message ==="
POST_STATUS=$(api "/v1/sessions/$SESSION_ID/events" -X POST \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"What is 2+2? Just answer the number."}]}]}' \
  -o /dev/null -w "%{http_code}")
check "post returns 202" "202" "$POST_STATUS"

echo ""
echo "=== 7. Waiting for response (max 60s)... ==="
ELAPSED=0
while [ $ELAPSED -lt 60 ]; do
  if grep -q "session.status_idle" "$SSE_FILE" 2>/dev/null; then break; fi
  if grep -q "session.error" "$SSE_FILE" 2>/dev/null; then echo "  ! Error detected"; break; fi
  sleep 2; ((ELAPSED+=2))
  printf "."
done
echo ""

kill $SSE_PID 2>/dev/null || true
wait $SSE_PID 2>/dev/null || true

echo ""
echo "=== 8. SSE Events ==="
cat "$SSE_FILE"

echo ""
echo "=== 9. Verify Events ==="
SSE=$(cat "$SSE_FILE")
check "got agent.message" "agent.message" "$SSE"
check "got status_idle" "session.status_idle" "$SSE"
check "got status_running" "session.status_running" "$SSE"

echo ""
echo "=== 10. Events Pagination (JSON) ==="
EVENTS_JSON=$(api "/v1/sessions/$SESSION_ID/events" -H "Accept: application/json")
EVENT_COUNT=$(echo "$EVENTS_JSON" | jq '.data | length')
check "events in JSON mode" "true" "$([ "$EVENT_COUNT" -gt 0 ] && echo true || echo false)"
echo "  Event count: $EVENT_COUNT"

echo ""
echo "=== 11. Session Status ==="
STATUS=$(api "/v1/sessions/$SESSION_ID" | jq -r .status)
check "session idle" "idle" "$STATUS"

echo ""
echo "=== 12. Agent Update ==="
UPDATED=$(api "/v1/agents/$AGENT_ID" -X PUT -d '{"description":"Updated via e2e"}')
check "agent updated" "Updated via e2e" "$UPDATED"
NEW_VER=$(echo "$UPDATED" | jq -r .version)
check "version incremented" "2" "$NEW_VER"

echo ""
echo "=== 13. Agent Versions ==="
VERSIONS=$(api "/v1/agents/$AGENT_ID/versions")
VER_COUNT=$(echo "$VERSIONS" | jq '.data | length')
check "version history exists" "1" "$VER_COUNT"

echo ""
echo "=== 14. Session Archive ==="
ARCHIVED=$(api "/v1/sessions/$SESSION_ID/archive" -X POST)
check "archived_at set" "archived_at" "$ARCHIVED"

echo ""
echo "=== 15. Cleanup ==="
api "/v1/agents/$AGENT_ID" -X DELETE > /dev/null
api "/v1/environments/$ENV_ID" -X DELETE > /dev/null
echo "  ✓ Cleaned up"

rm -f "$SSE_FILE"

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

[ $FAIL -eq 0 ] && exit 0 || exit 1
