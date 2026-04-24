#!/usr/bin/env bash
# Storage-layer smoke test against staging.
# Exercises every D1-backed store + the routes that wire them through the
# services container. Verifies wiring works end-to-end on real Cloudflare
# bindings (not just miniflare).
#
# Usage:
#   BASE=https://managed-agents-staging.hrhrngxy.workers.dev \
#   KEY=e2e-staging-test-key-2026-04-24 \
#   bash scripts/smoke-staging-storage.sh
#
# Each step echoes ✓ on pass, ✗ on fail. Hard exits on first failure so the
# trail of subsequent green checks doesn't lull you into thinking everything
# worked.

set -uo pipefail

BASE="${BASE:?Set BASE to staging worker URL}"
KEY="${KEY:?Set KEY to API key}"
DB="${DB:-openma-auth-staging}"

PASS=0
FAIL=0
LAST_VAULT_ID=""
LAST_CRED_ID=""
LAST_STORE_ID=""
LAST_FILE_ID=""
LAST_FILE_R2_KEY=""
LAST_MODEL_CARD_ID=""
LAST_MODEL_CARD_ID_2=""

api() {
  curl -sS "$BASE$1" -H "x-api-key: $KEY" -H "content-type: application/json" "${@:2}"
}

api_status() {
  curl -sS -o /dev/null -w "%{http_code}" "$BASE$1" -H "x-api-key: $KEY" -H "content-type: application/json" "${@:2}"
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $name"
    ((++PASS))
  else
    echo "  ✗ $name — expected '$expected', got '$actual'"
    ((++FAIL))
    echo ""
    echo "=== FAIL: aborting ==="
    echo "Pass: $PASS / Fail: $FAIL"
    exit 1
  fi
}

d1() {
  npx wrangler d1 execute "$DB" --remote --command "$1" --json 2>&1
}

#=============================================================================
echo "=== 1. Vaults store ==="
#=============================================================================

VAULT=$(api /v1/vaults -X POST -d '{"name":"smoke-vault"}')
LAST_VAULT_ID=$(echo "$VAULT" | jq -r .id)
check "POST /v1/vaults returns vault id" 'vlt-' "$LAST_VAULT_ID"

VAULT_GET=$(api "/v1/vaults/$LAST_VAULT_ID")
check "GET /v1/vaults/:id roundtrips" '"name":"smoke-vault"' "$VAULT_GET"

VAULT_LIST=$(api "/v1/vaults")
check "GET /v1/vaults includes the new vault" "$LAST_VAULT_ID" "$VAULT_LIST"

#=============================================================================
echo ""
echo "=== 2. Credentials store + partial UNIQUE ==="
#=============================================================================

# 2a. Create with mcp_oauth + mcp_server_url
CRED=$(api "/v1/vaults/$LAST_VAULT_ID/credentials" -X POST -d '{
  "display_name": "smoke-cred-1",
  "auth": {"type":"mcp_oauth","mcp_server_url":"https://smoke.example.com/sse","access_token":"secret-abc","refresh_token":"r1"}
}')
LAST_CRED_ID=$(echo "$CRED" | jq -r .id)
check "POST credential returns cred id" 'cred-' "$LAST_CRED_ID"

# 2b. Verify secrets stripped from response
check "credential response strips access_token" 'null' "$(echo "$CRED" | jq '.auth.access_token')"
check "credential response strips refresh_token" 'null' "$(echo "$CRED" | jq '.auth.refresh_token')"

# 2c. Duplicate mcp_server_url within same vault → 409 (partial UNIQUE in D1)
DUP_STATUS=$(api_status "/v1/vaults/$LAST_VAULT_ID/credentials" -X POST -d '{
  "display_name": "smoke-cred-dup",
  "auth": {"type":"mcp_oauth","mcp_server_url":"https://smoke.example.com/sse"}
}')
check "duplicate mcp_server_url returns 409 (partial UNIQUE)" "409" "$DUP_STATUS"

# 2d. command_secret (no mcp_server_url) — multiple allowed (NULL not in partial UNIQUE)
api "/v1/vaults/$LAST_VAULT_ID/credentials" -X POST -d '{
  "display_name": "cmd-1", "auth": {"type":"command_secret","env_var":"E_1","token":"t1"}
}' > /dev/null
CMD_STATUS=$(api_status "/v1/vaults/$LAST_VAULT_ID/credentials" -X POST -d '{
  "display_name": "cmd-2", "auth": {"type":"command_secret","env_var":"E_2","token":"t2"}
}')
check "second command_secret allowed (NULL mcp_url not in partial UNIQUE)" "201" "$CMD_STATUS"

# 2e. Archive + recreate same mcp_server_url succeeds
ARCH=$(api "/v1/vaults/$LAST_VAULT_ID/credentials/$LAST_CRED_ID/archive" -X POST)
check "archive credential returns archived_at set" '"archived_at":"' "$ARCH"

RECYCLE_STATUS=$(api_status "/v1/vaults/$LAST_VAULT_ID/credentials" -X POST -d '{
  "display_name": "smoke-cred-recycled",
  "auth": {"type":"mcp_oauth","mcp_server_url":"https://smoke.example.com/sse"}
}')
check "same mcp_server_url after archive returns 201 (active-only UNIQUE)" "201" "$RECYCLE_STATUS"

# 2f. mcp_server_url is immutable
IMMUT_STATUS=$(api_status "/v1/vaults/$LAST_VAULT_ID/credentials/$LAST_CRED_ID" -X POST -d '{
  "auth": {"mcp_server_url":"https://different.example.com/sse"}
}')
check "mcp_server_url immutable returns 400" "400" "$IMMUT_STATUS"

#=============================================================================
echo ""
echo "=== 3. Cross-store cascade: vault archive → credentials.archiveByVault ==="
#=============================================================================

# Create fresh vault + a couple of active credentials
V2=$(api /v1/vaults -X POST -d '{"name":"smoke-cascade-vault"}' | jq -r .id)
api "/v1/vaults/$V2/credentials" -X POST -d '{
  "display_name":"cc1","auth":{"type":"static_bearer","token":"t1"}
}' > /dev/null
api "/v1/vaults/$V2/credentials" -X POST -d '{
  "display_name":"cc2","auth":{"type":"static_bearer","token":"t2"}
}' > /dev/null

ACTIVE_BEFORE=$(api "/v1/vaults/$V2/credentials" | jq '[.data[] | select(.archived_at == null)] | length')
check "vault has 2 active credentials before archive" "2" "$ACTIVE_BEFORE"

api "/v1/vaults/$V2/archive" -X POST > /dev/null

ACTIVE_AFTER=$(api "/v1/vaults/$V2/credentials" | jq '[.data[] | select(.archived_at == null)] | length')
check "vault archive cascades — 0 active credentials after" "0" "$ACTIVE_AFTER"

#=============================================================================
echo ""
echo "=== 4. Memory store + FK-removed cascade (D1.batch) ==="
#=============================================================================

STORE=$(api /v1/memory_stores -X POST -d '{"name":"smoke-memstore"}')
LAST_STORE_ID=$(echo "$STORE" | jq -r .id)
check "POST /v1/memory_stores returns store id" 'memstore-' "$LAST_STORE_ID"

# Workers AI embedding may be unavailable in staging — bypass the route
# and seed memories+versions directly via D1 to exercise the cascade-delete
# path. The cascade behaviour (D1.batch deleting all 3 tables) is what
# this PR changed; embedding is orthogonal.
NOW=$(date +%s)000
SUFFIX=$(date +%s)
MID="mem-smoke-$SUFFIX"
VID="memver-smoke-$SUFFIX"
d1 "INSERT INTO memories (id, store_id, path, content, content_sha256, size_bytes, created_at, updated_at) VALUES ('$MID', '$LAST_STORE_ID', '/seed', 'hello', '0', 5, $NOW, $NOW)" > /dev/null
d1 "INSERT INTO memory_versions (id, memory_id, store_id, operation, path, content, content_sha256, size_bytes, actor_type, actor_id, created_at) VALUES ('$VID', '$MID', '$LAST_STORE_ID', 'created', '/seed', 'hello', '0', 5, 'system', 'smoke', $NOW)" > /dev/null

MEMS_BEFORE=$(d1 "SELECT COUNT(*) AS n FROM memories WHERE store_id = '$LAST_STORE_ID'" | jq -r '.[0].results[0].n')
check "1 memories row in D1 before delete (seeded direct)" "1" "$MEMS_BEFORE"

VERS_BEFORE=$(d1 "SELECT COUNT(*) AS n FROM memory_versions WHERE store_id = '$LAST_STORE_ID'" | jq -r '.[0].results[0].n')
check "1 memory_versions row before delete" "1" "$VERS_BEFORE"

# Delete the store — should batch DELETE memories + memory_versions + store atomically
DEL_STATUS=$(api_status "/v1/memory_stores/$LAST_STORE_ID" -X DELETE)
check "DELETE /v1/memory_stores returns 200" "200" "$DEL_STATUS"

MEMS_AFTER=$(d1 "SELECT COUNT(*) AS n FROM memories WHERE store_id = '$LAST_STORE_ID'" | jq -r '.[0].results[0].n')
check "memories cascade-deleted (FK-free, app layer batch)" "0" "$MEMS_AFTER"

VERS_AFTER=$(d1 "SELECT COUNT(*) AS n FROM memory_versions WHERE store_id = '$LAST_STORE_ID'" | jq -r '.[0].results[0].n')
check "memory_versions cascade-deleted" "0" "$VERS_AFTER"

STORE_AFTER=$(d1 "SELECT COUNT(*) AS n FROM memory_stores WHERE id = '$LAST_STORE_ID'" | jq -r '.[0].results[0].n')
check "memory_stores row deleted" "0" "$STORE_AFTER"

#=============================================================================
echo ""
echo "=== 5. Files store ==="
#=============================================================================

FILE=$(api /v1/files -X POST -d '{
  "filename":"smoke.txt","media_type":"text/plain","content":"aGVsbG8gd29ybGQ="
}')
LAST_FILE_ID=$(echo "$FILE" | jq -r .id)
LAST_FILE_R2_KEY=$(echo "$FILE" | jq -r '.r2_key // empty')
check "POST /v1/files returns file id" 'file-' "$LAST_FILE_ID"

FILES_LIST=$(api "/v1/files")
check "GET /v1/files lists new file" "$LAST_FILE_ID" "$FILES_LIST"

DEL_FILE_STATUS=$(api_status "/v1/files/$LAST_FILE_ID" -X DELETE)
check "DELETE /v1/files/:id returns 200" "200" "$DEL_FILE_STATUS"

FILES_GONE_STATUS=$(api_status "/v1/files/$LAST_FILE_ID")
check "deleted file returns 404 on GET" "404" "$FILES_GONE_STATUS"

#=============================================================================
echo ""
echo "=== 6. Model cards store + UNIQUE + partial UNIQUE on default ==="
#=============================================================================

RUN_TAG="smoke-$(date +%s)"

MC1=$(api /v1/model_cards -X POST -d "{
  \"model_id\":\"smoke-model-$RUN_TAG\",\"provider\":\"ant-compatible\",\"name\":\"smoke-mc-1\",\"api_key\":\"sk-smoke-1\",\"base_url\":\"https://example.com\"
}")
LAST_MODEL_CARD_ID=$(echo "$MC1" | jq -r .id)
check "POST /v1/model_cards returns card id" 'mdl-' "$LAST_MODEL_CARD_ID"

DUP_MC_STATUS=$(api_status /v1/model_cards -X POST -d "{
  \"model_id\":\"smoke-model-$RUN_TAG\",\"provider\":\"ant-compatible\",\"name\":\"dup\",\"api_key\":\"x\",\"base_url\":\"https://example.com\"
}")
check "duplicate model_id returns 409 (HARD UNIQUE)" "409" "$DUP_MC_STATUS"

# Different model_id, ok
MC2=$(api /v1/model_cards -X POST -d "{
  \"model_id\":\"smoke-model-2-$RUN_TAG\",\"provider\":\"ant-compatible\",\"name\":\"smoke-mc-2\",\"api_key\":\"sk-smoke-2\",\"base_url\":\"https://example.com\",\"is_default\":true
}")
LAST_MODEL_CARD_ID_2=$(echo "$MC2" | jq -r .id)
check "second card with is_default=true returns 201" 'mdl-' "$LAST_MODEL_CARD_ID_2"

DEFAULT_COUNT=$(d1 "SELECT COUNT(*) AS n FROM model_cards WHERE is_default = 1" | jq -r '.[0].results[0].n')
check "exactly 1 default per tenant after second is_default=true (partial UNIQUE)" "1" "$DEFAULT_COUNT"

#=============================================================================
echo ""
echo "=== 7. Eval runs store + partial active index ==="
#=============================================================================

# /v1/evals/runs requires an existing agent + env. Reuse what GAIA created
# earlier by querying the latest agent + env from D1 indirectly via API.
AGENT_ID=$(api "/v1/agents" | jq -r '.data[0].id // empty')
ENV_ID=$(api "/v1/environments" | jq -r '.data[0].id // empty')

if [[ -z "$AGENT_ID" || -z "$ENV_ID" ]]; then
  echo "  ⚠ skipping evals tests — no agent/env in tenant (run a session first)"
else
  # Spawn a tiny eval run synchronously via the route
  EVAL_RUN=$(api "/v1/evals/runs" -X POST -d "{
    \"agent_id\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\",\"suite\":\"smoke\",
    \"tasks\":[{\"id\":\"t1\",\"messages\":[\"echo hi\"],\"timeout_ms\":10000}]
  }")
  RUN_ID=$(echo "$EVAL_RUN" | jq -r '.run_id // .id // empty')
  if [[ -n "$RUN_ID" && "$RUN_ID" != "null" ]]; then
    check "POST /v1/evals/runs returns run id" 'evrun-' "$RUN_ID"
    # Partial active index serves: WHERE status IN ('pending','running')
    # Newly created run is pending → must show up here.
    LIST=$(api "/v1/evals/runs?status=pending&limit=50" | jq -r '[.data[].id] | tostring')
    check "GET /v1/evals/runs?status=pending lists newly created run (partial active index)" "$RUN_ID" "$LIST"
  else
    echo "  ⚠ /v1/evals/runs returned unexpected shape: $EVAL_RUN"
  fi
fi

#=============================================================================
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
[[ "$FAIL" -eq 0 ]]
