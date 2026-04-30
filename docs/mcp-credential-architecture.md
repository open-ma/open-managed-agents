# MCP & Vault Credential Architecture

> Where do credentials live, who can see them, and how do MCP / outbound HTTPS calls get authenticated.

## TL;DR

OMA's **vault** is the single source of truth for upstream credentials (MCP-server tokens, OAuth tokens, API keys). The agent itself — whether it's the cloud DO running `generateText`, the local daemon spawning `claude-agent-acp`, or the sandbox container running `curl` — **never holds plaintext credentials in memory**. All three callers know only `(tenantId, sessionId, server-name | hostname)` and ask the **main worker** to make the actual upstream call on their behalf. Main looks up the credential **live on every call** (no per-session snapshot in agent worker / DO), injects the bearer token, and forwards.

This mirrors [Anthropic Managed Agents' "credential proxy outside the harness"](https://www.anthropic.com/engineering/managed-agents) pattern — a prompt-injected agent has no credential to leak because there isn't one in its address space.

## Architecture diagram

```
                    ┌───────────────────────────┐
                    │  Vault (D1 + KV)          │  single source of truth
                    │  type=mcp_oauth | static_bearer │
                    └──────────────┬────────────┘
                                   │ live read on EVERY call
                                   │
              ┌────────────────────▼────────────────────┐
              │   apps/main worker                       │
              │   ┌────────────────────────────────────┐ │
              │   │ resolveProxyTargetByTenant         │ │  URL match (mcp_server)
              │   │ resolveOutboundCredentialByHost    │ │  hostname match
              │   │ forwardWithRefresh                 │ │  inject + 401-refresh
              │   └────────────────────────────────────┘ │
              │   exposes three entrypoints:             │
              │   ① HTTP /v1/mcp-proxy/<sid>/<server>    │
              │   ② McpProxyRpc.mcpForward (RPC)         │
              │   ③ McpProxyRpc.outboundForward (RPC)    │
              └────┬─────────────┬────────────┬─────────┘
                   │             │            │
       ┌───────────┘             │            └───────────┐
       │ HTTP                    │ RPC                    │ RPC
       │ Bearer apiKey           │ binding=auth           │ binding=auth
       ▼                         ▼                        ▼
  ┌──────────────┐       ┌───────────────┐       ┌────────────────────┐
  │ ACP child    │       │ Cloud DO      │       │ Sandbox container  │
  │ (user laptop)│       │ (BindingMCP   │       │ (HTTPS interceptor │
  │              │       │  Transport)   │       │  via               │
  │              │       │               │       │  inject_vault_creds)│
  └──────────────┘       └───────────────┘       └────────────────────┘
       │                         │                        │
       └─── these three layers DO NOT hold any plaintext vault credential ───┘
```

## The three callers

| Caller | What it knows | How it asks | Why |
|---|---|---|---|
| **Local-runtime ACP child** (`claude-agent-acp` spawned by the user's daemon) | `(sid, server_name, agent api key)` | HTTP `POST /v1/mcp-proxy/<sid>/<server>` with `Authorization: Bearer <agentApiKey>` | Daemon already has an apiKey from `oma bridge setup`. HTTP works over the public network |
| **Cloud agent DO** (cloud-side `generateText` loop) | `(tenantId, sid, server_name)` | `env.MAIN_MCP.mcpForward(...)` via Cloudflare service-binding RPC | Binding scope IS the auth — only Workers configured with `services[].entrypoint = "McpProxyRpc"` can invoke it. No apiKey to manage |
| **Sandbox container** (the HTTPS-intercepted shell of the cloud agent's container) | The full upstream URL it wants to fetch — that's it | `env.MAIN_MCP.outboundForward(...)` via the same service binding (called by the agent worker's `inject_vault_creds` outbound handler in `apps/agent/src/oma-sandbox.ts`) | Same — binding scope is the auth |

All three converge on `apps/main/src/routes/mcp-proxy.ts`'s shared helpers:
- `resolveProxyTargetByTenant(env, services, tenantId, sid, serverName)` — for MCP servers, matches by URL
- `resolveOutboundCredentialByHost(env, services, tenantId, sid, hostname)` — for arbitrary HTTPS, matches by hostname
- `forwardWithRefresh(services, tenantId, target, method, headers, body, audit?)` — fetch upstream + auto-refresh on 401 + audit log

## OAuth refresh on 401

For credentials of type `mcp_oauth`, `forwardWithRefresh` automatically:

1. First fetch with current `access_token` → upstream returns `401`
2. Drain the response body
3. Re-fetch the credential row from D1 (dedup check — see "Concurrent refresh dedup" below)
4. If D1's `access_token` matches the one we just got 401'd with: actually call `token_endpoint` with the `refresh_token`
5. Persist rotated `{access_token, refresh_token, expires_at}` back to D1 via `services.credentials.refreshAuth` (a single canonical write — no per-session snapshot mutation)
6. Retry the upstream call once with the fresh bearer

If the refresh itself fails (refresh_token revoked, scopes removed, network error), the second upstream call returns the original 401 to the caller — no false-success masking.

## Concurrent refresh dedup

When N parallel tool calls all hit their access_token's expiry in the same instant (typical at the 1h boundary mid-multi-tool conversation), all N would naively call `token_endpoint` simultaneously. For upstreams with rotating refresh_token (Linear, Notion, …) all but the first would invalidate themselves.

Mitigation: before calling `token_endpoint`, `tryRefreshOauth` re-fetches the credential row from D1. If the live `access_token` has moved past the stale one we just got 401'd with, another in-flight call already refreshed — return the live token, skip the upstream roundtrip.

This isn't a perfect mutex — two calls re-fetching D1 BEFORE either persists will both refresh — but it cuts the race window from "every concurrent 401" to "two 401s landing in the same low single-digit ms". A perfect mutex would need a per-credential Durable Object; not built until production logs show double-refresh damage.

## Audit log

Every call through `forwardWithRefresh` emits a structured log line:

```json
{
  "op": "mcp_proxy.forward",
  "caller": "http" | "rpc-mcp" | "rpc-outbound",
  "tenant_id": "...",
  "session_id": "...",
  "server": "linear",     // for MCP path; absent for outbound
  "host": "mcp.linear.app",
  "method": "POST",
  "status": 200,
  "refreshed": true | false,
  "ms": 1234
}
```

Production incident response can answer "who called what when" without per-call-site instrumentation. Refresh failures emit a separate `op: mcp_proxy.refresh_failed` line at warn level.

## What this DOESN'T cover

- **`command_secret` credentials** (e.g. `GIT_TOKEN` injected as env var on `git` commands) still flow into the sandbox container's per-command process env. The injection is AST-gated — the SDK only injects on single simple commands matching the registered prefix exactly, not on shell composition (`&&`, `;`, `|`). Casual `env | grep` from the model returns nothing. **Targeted prompt injection** that crafts single-command-form leak vectors specific to the binary (e.g. `git fetch -c http.extraHeader="x-leak: $(env)"`) can still exfiltrate. Until command_secret moves to the same out-of-sandbox proxy pattern as MCP/outbound, **don't attach high-blast-radius credentials** (org-wide GitHub PAT, prod database creds) to agents that handle untrusted input.

- **Real upstream OAuth providers** with quirks (Notion's scope-on-refresh, Slack's webhook-style auth, GitHub App installation tokens that aren't OAuth) need provider-specific handling. The current refresh path covers the standard OAuth 2.1 `grant_type=refresh_token` shape; one-off providers may need their own refresh helper.

- **Streaming uploads** through `outboundForward` — the RPC body type is `string | null`, so multi-MB binary uploads from sandbox `curl -F file=@big.pdf` would need the body type widened to `ArrayBuffer | ReadableStream` first. OMA's current use cases don't trip this.

- **Rate limiting** — there's no per-credential / per-session quota in mcp-proxy. A misbehaving agent can spam an upstream MCP server until it rate-limits the entire tenant. Future work; not currently a production blocker because OMA traffic is well below any upstream's free-tier limits.

## Deploy ordering invariant

Cloud agent's `MAIN_MCP` service binding points at `managed-agents-staging#McpProxyRpc` (or the prod equivalent). Cloudflare resolves bindings at request time, so:

- **Forward**: deploy main first (entrypoint exists), then agent (binds to it)
- **Rollback**: deploy agent first (stop calling the new entrypoint), then main (safe to revert the class)

Both `.github/workflows/deploy.yml` and `deploy-lane.yml` enforce the forward order. Manual rollbacks must respect the inverse — Cloudflare doesn't enforce it.

## Testing

### Unit — `test/unit/mcp-proxy-refresh.test.ts`

5 vitest cases against `forwardWithRefresh` with mocked global fetch + in-memory `CredentialService`:

1. Happy path 200 → no refresh, no D1 write
2. 401 → refresh succeeds → retry 200 + D1 update
3. Concurrent dedup: D1 already-rotated → skip token_endpoint
4. Refresh fails (token_endpoint 400) → original 401 surfaced
5. `static_bearer` (no `.refresh` metadata) → 401 returned immediately

Runs in `<500ms`, no CF infra required.

### End-to-end — `test/fixtures/fake-oauth-mcp/`

Standalone CF Worker that plays both OAuth provider and MCP server. Deploy to a sandbox CF account, seed an `mcp_oauth` credential pointing at it, create a cloud agent + session, fire a prompt, observe the actual binding-RPC + refresh + retry chain. See the fixture's `README.md` for the full operator runbook.

The tool the fake MCP server exposes (`fake_echo`) returns the access_token used in the response text — so the e2e assertion is just "did the model see the post-refresh token in the echoed text". This is the closest we get to an OAuth-refresh production drill without burning real-provider credentials.

## References

- [Anthropic Managed Agents architecture (Anthropic Engineering)](https://www.anthropic.com/engineering/managed-agents)
- [Inside Claude Managed Agents (Pluto Security)](https://pluto.security/blog/inside-claude-managed-agents/)
- `apps/main/src/routes/mcp-proxy.ts` — resolvers + forwardWithRefresh
- `apps/main/src/index.ts` (`McpProxyRpc`) — RPC entrypoint
- `apps/agent/src/runtime/binding-mcp-transport.ts` — AI SDK MCPTransport adapter
- `apps/agent/src/oma-sandbox.ts` — sandbox HTTPS interceptor
- `apps/agent/src/runtime/sandbox.ts` (`setOutboundContext`) — interceptor binding wire-up
