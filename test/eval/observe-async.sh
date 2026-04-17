#!/usr/bin/env bash
# Observe async drainEventQueue behavior
# Usage: OMA_API_URL=... OMA_API_KEY=... bash test/eval/observe-async.sh
set -euo pipefail

API="${OMA_API_URL:-https://openma.dev}"
KEY="${OMA_API_KEY}"
H=(-H "x-api-key: $KEY" -H "Content-Type: application/json")

echo "=== Step 1: Create session ==="
SESSION=$(curl -s -X POST "$API/v1/sessions" "${H[@]}" \
  -d '{"agent": "agent-lmpvhomfo8fs408b", "environment_id": "env-qisw0fmtm88nqwyk", "title": "observe-async"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERROR'))")
echo "Session: $SESSION"

echo ""
echo "=== Step 2: POST message (measure response time) ==="
START=$(date +%s)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/v1/sessions/$SESSION/events" "${H[@]}" \
  -d '{"events": [{"type": "user.message", "content": [{"type": "text", "text": "Run: echo hello && echo DONE"}]}]}' \
  --max-time 120)
END=$(date +%s)
ELAPSED=$((END - START))
echo "HTTP status: $HTTP_CODE"
echo "Response time: ${ELAPSED}s"
if [ "$ELAPSED" -lt 5 ]; then
  echo "OBSERVATION: POST returned fast (<5s) — async is working"
elif [ "$ELAPSED" -gt 30 ]; then
  echo "OBSERVATION: POST blocked for ${ELAPSED}s — still synchronous"
else
  echo "OBSERVATION: POST took ${ELAPSED}s — ambiguous"
fi

echo ""
echo "=== Step 3: Poll events until idle (max 5 min) ==="
for i in $(seq 1 60); do
  sleep 5
  EVENTS=$(curl -s "$API/v1/sessions/$SESSION/events?limit=50&order=asc" -H "x-api-key: $KEY")
  COUNT=$(echo "$EVENTS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  TYPES=$(echo "$EVENTS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
types = []
for e in d.get('data',[]):
    ev = json.loads(e['data']) if isinstance(e.get('data'), str) else e.get('data', e)
    types.append(ev.get('type','?'))
print(' → '.join(types))
" 2>/dev/null)
  echo "  [${i}] events=$COUNT: $TYPES"

  # Check for terminal states
  echo "$TYPES" | grep -q "session.status_idle" && echo "OBSERVATION: Reached idle — harness completed" && break
  echo "$TYPES" | grep -q "session.error" && echo "OBSERVATION: Error occurred" && break
done

echo ""
echo "=== Step 4: Final event dump ==="
curl -s "$API/v1/sessions/$SESSION/events?limit=50&order=asc" -H "x-api-key: $KEY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
events = d.get('data',[])
print(f'Total events: {len(events)}')
for e in events:
    ev = json.loads(e['data']) if isinstance(e.get('data'), str) else e.get('data', e)
    t = ev.get('type','?')
    extra = ''
    if t == 'agent.tool_use': extra = f' name={ev.get(\"name\")}'
    if t == 'agent.tool_result': extra = f' [{str(ev.get(\"content\",\"\"))[:80]}]'
    if t == 'session.error': extra = f' ERR: {ev.get(\"error\",\"\")[:150]}'
    if t == 'session.status_idle': extra = ' ★ IDLE'
    print(f'  {e[\"ts\"][:19]} {t}{extra}')
"

echo ""
echo "=== Summary ==="
echo "POST response time: ${ELAPSED}s (HTTP $HTTP_CODE)"
echo "Session: $SESSION"
