# Fake OAuth + MCP server (test fixture)

A throwaway Cloudflare Worker that **plays both** OAuth provider and MCP server, used to exercise OMA's `forwardWithRefresh` 401-triggered refresh path end-to-end without needing real Linear/Notion/etc. dev OAuth apps.

**Not for production.** No real authentication, no rate limits, no encryption at rest beyond what KV gives you. Intended to live on a sandbox CF account or a clearly-labeled subdomain (e.g. `oma-fake-oauth-mcp.<your>.workers.dev`).

## What it does

| Endpoint | Behavior |
|---|---|
| `GET /` | Plain-text help |
| `GET /__state` | Returns current `{current_access, current_refresh, issued_count, last_refresh_at}` |
| `GET /__reset` | Wipes state. Re-bootstraps to `current_refresh="refresh-0"` |
| `POST /oauth/token` | Accepts `grant_type=refresh_token`. If `refresh_token` matches `current_refresh`, rotates and returns new `{access_token, refresh_token, expires_in:3600}`. Else 400 `invalid_grant` (mirrors Linear's rotating-refresh behavior) |
| `POST /mcp` | MCP JSON-RPC. Returns 401 if `Authorization: Bearer <X>` doesn't match `current_access`. Else handles `initialize`, `tools/list` (returns one tool `fake_echo`), `tools/call` (echoes input + the access_token used). |

## Deploy

One-time setup:

```sh
cd test/fixtures/fake-oauth-mcp
pnpm install   # or npm
npx wrangler kv namespace create FAKE_STATE
# → copy the printed `id` into wrangler.jsonc kv_namespaces[0].id
npx wrangler deploy
# → note the published URL, e.g. https://oma-fake-oauth-mcp.<acct>.workers.dev
```

## Use from OMA

Seed a vault credential pointing at the fake server:

```sh
ORIGIN="https://oma-fake-oauth-mcp.<acct>.workers.dev"

curl -sX POST "https://app.staging.openma.dev/v1/vaults/<vault-id>/credentials" \
  -H "x-api-key: <oma-api-key>" \
  -H "Content-Type: application/json" \
  -d "{
    \"display_name\": \"fake-oauth-test\",
    \"auth\": {
      \"type\": \"mcp_oauth\",
      \"mcp_server_url\": \"${ORIGIN}/mcp\",
      \"access_token\": \"stale-deliberately\",
      \"refresh_token\": \"refresh-0\",
      \"token_endpoint\": \"${ORIGIN}/oauth/token\",
      \"client_id\": \"test-client\"
    }
  }"
```

Create a cloud agent with `mcp_servers: [{name:"fake", type:"http", url:"${ORIGIN}/mcp"}]` and a session bound to the vault. Fire a prompt asking the agent to use `fake_echo`. Expected behavior:

1. First MCP request from cloud agent → fake server returns 401 (token is `"stale-deliberately"`, current is `"stale-bootstrap"`)
2. `forwardWithRefresh` calls `${ORIGIN}/oauth/token` with `refresh_token=refresh-0` → fake returns `{access_token:"fresh-1", refresh_token:"refresh-1"}`
3. `services.credentials.refreshAuth` writes new tokens to D1
4. Retry MCP request with `Bearer fresh-1` → fake returns valid response
5. main worker audit log: `op=mcp_proxy.forward refreshed=true status=200`

Verify state advanced:

```sh
curl ${ORIGIN}/__state
# → { current_access:"fresh-1", current_refresh:"refresh-1", issued_count:1, last_refresh_at:... }
```

Reset between runs:

```sh
curl ${ORIGIN}/__reset
# Then update OMA's vault credential's access_token back to "stale-deliberately"
# and refresh_token back to "refresh-0" via API to repeat the scenario.
```

## Cleanup

```sh
npx wrangler delete
npx wrangler kv namespace delete --namespace-id <id-from-create>
```
