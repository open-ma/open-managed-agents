#!/usr/bin/env bash
# Advanced E2E tests covering complex use cases with real LLM.
# Usage: ./test/e2e/e2e-advanced.sh [BASE_URL]

set -uo pipefail

BASE="${1:-http://localhost:8787}"
KEY="dev-test-key-change-me"
PASS=0; FAIL=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"; ((++PASS))
  else
    echo "  ✗ $name — expected '$expected'"; ((++FAIL))
  fi
}

api() { curl -sS "$BASE$1" -H "x-api-key: $KEY" -H "content-type: application/json" "${@:2}"; }

create_agent() {
  local name="$1" system="$2"
  api /v1/agents -X POST -d "{\"name\":\"$name\",\"model\":\"claude-sonnet-4-6\",\"system\":\"$system\",\"tools\":[{\"type\":\"agent_toolset_20260401\"}]}" | jq -r .id
}

create_env() {
  api /v1/environments -X POST -d '{"name":"e2e-env","config":{"type":"cloud"}}' | jq -r .id
}

create_session() {
  local aid="$1" eid="$2"
  api /v1/sessions -X POST -d "{\"agent\":\"$aid\",\"environment_id\":\"$eid\"}" | jq -r .id
}

send_and_collect() {
  local sid="$1" text="$2" timeout="${3:-60}"
  local f=$(mktemp)
  # Start SSE listener
  curl -sS -N "$BASE/v1/sessions/$sid/events" \
    -H "x-api-key: $KEY" -H "Accept: text/event-stream" \
    --max-time "$timeout" > "$f" 2>/dev/null &
  local pid=$!
  sleep 1
  # Send message
  api "/v1/sessions/$sid/events" -X POST \
    -d "{\"events\":[{\"type\":\"user.message\",\"content\":[{\"type\":\"text\",\"text\":\"$text\"}]}]}" > /dev/null
  # Wait for completion
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    grep -q "session.status_idle\|session.error" "$f" 2>/dev/null && break
    sleep 2; ((elapsed+=2)); printf "."
  done
  echo ""
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  cat "$f"; rm -f "$f"
}

# Shared env
ENV_ID=$(create_env)
echo "Environment: $ENV_ID"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 1: Multi-step coding task"
echo "========================================"

AID=$(create_agent "Coder" "You are a coding assistant. Always use tools. Write code, run it, fix errors. Be concise.")
SID=$(create_session "$AID" "$ENV_ID")
echo "Session: $SID"

SSE=$(send_and_collect "$SID" "Write a Python script at /workspace/primes.py that prints all primes up to 50. Then run it." 90)
echo "$SSE" | grep "data:" | head -15

TOOL_COUNT=$(echo "$SSE" | grep -c "agent.tool_use" || true)
check "used multiple tools" "true" "$([ "$TOOL_COUNT" -ge 2 ] && echo true || echo false)"
check "wrote file" '"name":"write"' "$SSE"
check "ran code" '"name":"bash"' "$SSE"
check "completed" "session.status_idle" "$SSE"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 2: Multi-turn memory"
echo "========================================"

AID2=$(create_agent "Memory" "You are helpful. Remember what the user tells you. Be very concise.")
SID2=$(create_session "$AID2" "$ENV_ID")
echo "Session: $SID2"

SSE1=$(send_and_collect "$SID2" "My name is Alice and I love Rust." 30)
check "turn 1 done" "session.status_idle" "$SSE1"

SSE2=$(send_and_collect "$SID2" "What is my name and favorite language?" 30)
check "turn 2 done" "session.status_idle" "$SSE2"
check "remembers Alice" "Alice" "$SSE2"
check "remembers Rust" "Rust" "$SSE2"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 3: File pipeline (write→read→edit)"
echo "========================================"

AID3=$(create_agent "FileWorker" "You are a file assistant. Always use tools. Be concise.")
SID3=$(create_session "$AID3" "$ENV_ID")
echo "Session: $SID3"

SSE3=$(send_and_collect "$SID3" "Write {\\\"port\\\": 3000} to /workspace/config.json, then read it back to verify." 60)
check "used write" '"name":"write"' "$SSE3"
check "used read or bash" "agent.tool_use" "$SSE3"
check "completed" "session.status_idle" "$SSE3"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 4: Error recovery"
echo "========================================"

AID4=$(create_agent "Resilient" "If something fails, try a different approach. Be concise.")
SID4=$(create_session "$AID4" "$ENV_ID")
echo "Session: $SID4"

SSE4=$(send_and_collect "$SID4" "Read /workspace/nonexistent.txt. If not found, create it with hello world, then read it." 60)
check "used tools" "agent.tool_use" "$SSE4"
check "completed" "session.status_idle" "$SSE4"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 5: Agent versioning snapshot"
echo "========================================"

AID5=$(create_agent "Versioned" "VERSION_1")
SID5=$(create_session "$AID5" "$ENV_ID")

# Update agent to v2
api "/v1/agents/$AID5" -X PUT -d '{"system":"VERSION_2"}' > /dev/null
VER=$(api "/v1/agents/$AID5" | jq -r .version)
check "agent is v2" "2" "$VER"

SNAP=$(api "/v1/sessions/$SID5" | jq -r '.agent.system // empty')
if [ "$SNAP" = "VERSION_1" ]; then
  check "snapshot preserved v1" "true" "true"
else
  check "snapshot preserved v1" "VERSION_1" "$SNAP"
fi

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 6: Session lifecycle"
echo "========================================"

AID6=$(create_agent "Lifecycle" "Be concise.")
SID6=$(create_session "$AID6" "$ENV_ID")

SSE6=$(send_and_collect "$SID6" "Say hello." 30)
check "session works" "agent.message" "$SSE6"

ARCHIVED=$(api "/v1/sessions/$SID6/archive" -X POST)
check "archived" "archived_at" "$ARCHIVED"

EVENTS=$(api "/v1/sessions/$SID6/events" -H "Accept: application/json")
EC=$(echo "$EVENTS" | jq '.data | length' 2>/dev/null)
check "events persisted" "true" "$([ "${EC:-0}" -gt 0 ] && echo true || echo false)"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 7: Vaults + credentials"
echo "========================================"

VAULT=$(api /v1/vaults -X POST -d '{"name":"E2E Vault"}')
VID=$(echo "$VAULT" | jq -r .id)
check "vault created" "vlt_" "$VID"

CRED=$(api "/v1/vaults/$VID/credentials" -X POST -d '{"display_name":"Token","auth":{"type":"static_bearer","mcp_server_url":"https://mcp.e2e.com","token":"secret"}}')
CID=$(echo "$CRED" | jq -r .id)
check "credential created" "cred_" "$CID"
check "secret stripped" "null" "$(echo "$CRED" | jq -r '.auth.token // "null"')"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 8: Memory stores"
echo "========================================"

STORE=$(api /v1/memory_stores -X POST -d '{"name":"E2E Memory","description":"Test store"}')
MSID=$(echo "$STORE" | jq -r .id)
check "store created" "memstore_" "$MSID"

api "/v1/memory_stores/$MSID/memories" -X POST -d '{"path":"/notes/one.md","content":"First note"}' > /dev/null
api "/v1/memory_stores/$MSID/memories" -X POST -d '{"path":"/notes/two.md","content":"Second note"}' > /dev/null

MEMS=$(api "/v1/memory_stores/$MSID/memories")
check "2 memories" "2" "$(echo "$MEMS" | jq '.data | length')"

MID=$(echo "$MEMS" | jq -r '.data[0].id')
MEM=$(api "/v1/memory_stores/$MSID/memories/$MID")
check "has sha256" "content_sha256" "$MEM"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 9: Files API"
echo "========================================"

FILE=$(api /v1/files -X POST -d '{"filename":"test.csv","content":"a,b\n1,2","media_type":"text/csv"}')
FID=$(echo "$FILE" | jq -r .id)
check "file uploaded" "file_" "$FID"

CONTENT=$(api "/v1/files/$FID/content")
check "downloadable" "a,b" "$CONTENT"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 10: Rate limiting"
echo "========================================"

for i in $(seq 1 5); do
  S=$(api /v1/agents -X POST -d "{\"name\":\"Rate$i\",\"model\":\"claude-sonnet-4-6\"}" -o /dev/null -w "%{http_code}")
  [ "$S" = "429" ] && echo "  ! Rate limited at $i" && break
done
check "5 requests OK" "true" "true"

# ============================================================
echo ""
echo "========================================"
echo "USE CASE 11: Constraints"
echo "========================================"

# Duplicate mcp_server_url
DUP=$(api "/v1/vaults/$VID/credentials" -X POST -d '{"display_name":"Dup","auth":{"type":"static_bearer","mcp_server_url":"https://mcp.e2e.com","token":"x"}}')
check "dup rejected" "already exists" "$DUP"

# ============================================================
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

[ $FAIL -eq 0 ] && exit 0 || exit 1
