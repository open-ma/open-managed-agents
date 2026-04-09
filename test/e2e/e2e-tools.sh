#!/usr/bin/env bash
# E2E test that exercises real tool usage (bash, write, read).
# The LLM must actually decide to use tools and the full loop must work.
# Usage: ./test/e2e-tools.sh [BASE_URL]

set -uo pipefail

BASE="${1:-http://localhost:8787}"
KEY="dev-test-key-change-me"
PASS=0; FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"; ((PASS++))
  else
    echo "  ✗ $name — expected '$expected'"; ((FAIL++))
  fi
}

api() {
  curl -sS "$BASE$1" -H "x-api-key: $KEY" -H "content-type: application/json" "${@:2}"
}

collect_sse() {
  local sess_id="$1" timeout="${2:-90}"
  local sse_file=$(mktemp)

  curl -sS -N "$BASE/v1/sessions/$sess_id/events" \
    -H "x-api-key: $KEY" -H "Accept: text/event-stream" \
    --max-time "$timeout" > "$sse_file" 2>/dev/null &
  local pid=$!
  sleep 1

  echo "$sse_file:$pid"
}

wait_for_idle() {
  local sse_file="$1" pid="$2" timeout="${3:-90}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if grep -q "session.status_idle\|session.error" "$sse_file" 2>/dev/null; then break; fi
    sleep 2; ((elapsed+=2)); printf "."
  done
  echo ""
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

send_msg() {
  local sess_id="$1" text="$2"
  api "/v1/sessions/$sess_id/events" -X POST \
    -d "{\"events\":[{\"type\":\"user.message\",\"content\":[{\"type\":\"text\",\"text\":\"$text\"}]}]}" \
    -o /dev/null -w "%{http_code}"
}

# Setup
echo "=== Setup ==="
AGENT=$(api /v1/agents -X POST -d '{
  "name":"Tool Test Agent",
  "model":"claude-sonnet-4-6",
  "system":"You are a coding assistant. When asked to create files or run commands, always use the available tools (bash, write, read). Be concise.",
  "tools":[{"type":"agent_toolset_20260401"}]
}')
AGENT_ID=$(echo "$AGENT" | jq -r .id)
echo "Agent: $AGENT_ID"

ENV=$(api /v1/environments -X POST -d '{"name":"tools-env","config":{"type":"cloud"}}')
ENV_ID=$(echo "$ENV" | jq -r .id)
echo "Env: $ENV_ID"

# ============================================================
# Test 1: Write a file (expects write tool)
# ============================================================
echo ""
echo "========================================"
echo "TEST 1: Write a file using write tool"
echo "========================================"

SESS1=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"Write Test\"}")
SESS1_ID=$(echo "$SESS1" | jq -r .id)
echo "Session: $SESS1_ID"

IFS=: read SSE_FILE SSE_PID <<< "$(collect_sse "$SESS1_ID")"
send_msg "$SESS1_ID" "Create a file called hello.py with a simple hello world program. Use the write tool."
echo "Waiting for agent..."
wait_for_idle "$SSE_FILE" "$SSE_PID" 60

echo "--- Events ---"
cat "$SSE_FILE"
echo ""

SSE=$(cat "$SSE_FILE")
check "agent used write tool" "agent.tool_use" "$SSE"
check "tool name is write" '"name":"write"' "$SSE"
check "tool result received" "agent.tool_result" "$SSE"
check "session went idle" "session.status_idle" "$SSE"
check "got agent message" "agent.message" "$SSE"
rm -f "$SSE_FILE"

# ============================================================
# Test 2: Run a bash command (expects bash tool)
# ============================================================
echo ""
echo "========================================"
echo "TEST 2: Run a bash command"
echo "========================================"

SESS2=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"Bash Test\"}")
SESS2_ID=$(echo "$SESS2" | jq -r .id)
echo "Session: $SESS2_ID"

IFS=: read SSE_FILE SSE_PID <<< "$(collect_sse "$SESS2_ID")"
send_msg "$SESS2_ID" "Run the command 'echo hello world' using the bash tool."
echo "Waiting for agent..."
wait_for_idle "$SSE_FILE" "$SSE_PID" 60

echo "--- Events ---"
cat "$SSE_FILE"
echo ""

SSE=$(cat "$SSE_FILE")
check "agent used bash tool" '"name":"bash"' "$SSE"
check "bash input has command" '"command"' "$SSE"
check "tool result exists" "agent.tool_result" "$SSE"
check "session completed" "session.status_idle" "$SSE"
rm -f "$SSE_FILE"

# ============================================================
# Test 3: Multi-step (write + bash + read)
# ============================================================
echo ""
echo "========================================"
echo "TEST 3: Multi-step tool usage"
echo "========================================"

SESS3=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"Multi-step\"}")
SESS3_ID=$(echo "$SESS3" | jq -r .id)
echo "Session: $SESS3_ID"

IFS=: read SSE_FILE SSE_PID <<< "$(collect_sse "$SESS3_ID")"
send_msg "$SESS3_ID" "Write a Python script to /workspace/fib.py that prints the first 5 fibonacci numbers, then run it with bash, then read the file to verify."
echo "Waiting for agent..."
wait_for_idle "$SSE_FILE" "$SSE_PID" 90

echo "--- Events ---"
cat "$SSE_FILE"
echo ""

SSE=$(cat "$SSE_FILE")
# Count tool_use events
TOOL_USE_COUNT=$(echo "$SSE" | grep -c "agent.tool_use" || true)
echo "  Tool calls made: $TOOL_USE_COUNT"
check "multiple tool calls (>=2)" "true" "$([ "$TOOL_USE_COUNT" -ge 2 ] && echo true || echo false)"
check "used write tool" '"name":"write"' "$SSE"
check "used bash tool" '"name":"bash"' "$SSE"
check "session completed" "session.status_idle" "$SSE"
rm -f "$SSE_FILE"

# ============================================================
# Test 4: Multi-turn conversation
# ============================================================
echo ""
echo "========================================"
echo "TEST 4: Multi-turn conversation"
echo "========================================"

SESS4=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"Multi-turn\"}")
SESS4_ID=$(echo "$SESS4" | jq -r .id)
echo "Session: $SESS4_ID"

# Turn 1
IFS=: read SSE_FILE SSE_PID <<< "$(collect_sse "$SESS4_ID")"
send_msg "$SESS4_ID" "Write a file /workspace/count.txt with the text 'count: 1'"
echo "Turn 1: waiting..."
wait_for_idle "$SSE_FILE" "$SSE_PID" 60
T1_SSE=$(cat "$SSE_FILE")
check "turn 1: used write" '"name":"write"' "$T1_SSE"
rm -f "$SSE_FILE"

# Turn 2 (same session — should remember context)
IFS=: read SSE_FILE SSE_PID <<< "$(collect_sse "$SESS4_ID")"
send_msg "$SESS4_ID" "Now read the file /workspace/count.txt and tell me what it says."
echo "Turn 2: waiting..."
wait_for_idle "$SSE_FILE" "$SSE_PID" 60
T2_SSE=$(cat "$SSE_FILE")
check "turn 2: used read" '"name":"read"' "$T2_SSE"
check "turn 2: got agent reply" "agent.message" "$T2_SSE"
rm -f "$SSE_FILE"

# Verify events pagination shows all events from both turns
EVENTS=$(api "/v1/sessions/$SESS4_ID/events" -H "Accept: application/json")
EVENT_COUNT=$(echo "$EVENTS" | jq '.data | length')
echo "  Total events across 2 turns: $EVENT_COUNT"
check "multi-turn events accumulated" "true" "$([ "$EVENT_COUNT" -ge 6 ] && echo true || echo false)"

# ============================================================
# Test 5: Interrupt
# ============================================================
echo ""
echo "========================================"
echo "TEST 5: User interrupt"
echo "========================================"

SESS5=$(api /v1/sessions -X POST -d "{\"agent\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"title\":\"Interrupt\"}")
SESS5_ID=$(echo "$SESS5" | jq -r .id)
echo "Session: $SESS5_ID"

# Send interrupt (even without a running task, it should be accepted)
INT_STATUS=$(api "/v1/sessions/$SESS5_ID/events" -X POST \
  -d '{"events":[{"type":"user.interrupt"}]}' -o /dev/null -w "%{http_code}")
check "interrupt accepted (202)" "202" "$INT_STATUS"

# ============================================================
# Cleanup
# ============================================================
echo ""
echo "=== Cleanup ==="
api "/v1/agents/$AGENT_ID" -X DELETE > /dev/null
api "/v1/environments/$ENV_ID" -X DELETE > /dev/null
echo "  ✓ Cleaned up"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

[ $FAIL -eq 0 ] && exit 0 || exit 1
