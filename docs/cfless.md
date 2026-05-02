# CFless OMA — single-process Node deployment

A Node-side build of Open Managed Agents that runs on a single VPS / Mac /
Docker host without any Cloudflare account, Workers, Durable Objects, or
Containers. Storage is SQLite + local filesystem. Sandboxes are local
subprocesses by default; switch to E2B for Firecracker isolation when
you're past trusted-developer territory.

> **Status:** Working PoC, not production. The CFless route is a parallel
> implementation of the same `Services` abstractions used on Cloudflare.
> Many production-relevant pieces (auth, vaults, multi-tenant) still
> default to single-tenant + no-auth in this build. See "What works /
> doesn't" below.

## Quick start (Docker)

```bash
# 1. Get an Anthropic API key. Any Anthropic-compatible endpoint works.
cp .env.cfless.example .env
$EDITOR .env  # set ANTHROPIC_API_KEY

# 2. Start
docker compose -f docker-compose.cfless.yml up --build

# 3. Sanity check
curl localhost:8787/health
# → {"status":"ok","runtime":"node",...}

# 4. Create + drive an agent
AID=$(curl -s -X POST localhost:8787/v1/agents \
  -H 'content-type: application/json' \
  -d '{"name":"shell","model":"claude-sonnet-4-6","system":"Use bash to answer.","tools":[{"type":"agent_toolset_20260401"}]}' \
  | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AID\"}" | jq -r .id)

# Open a streaming SSE in one terminal:
curl -N localhost:8787/v1/sessions/$SID/events/stream &

# Send a message in another:
curl -s -X POST localhost:8787/v1/sessions/$SID/events \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: ls -la / | head"}]}]}'

# Watch the SSE — you should see agent.message_chunk → agent.tool_use →
# agent.tool_result → agent.message → session.status_idle
```

## Quick start (no Docker)

```bash
pnpm install
ANTHROPIC_API_KEY=sk-... pnpm --filter @open-managed-agents/main-node start
# Same curl flow as above against localhost:8787.
```

State lives at `./data/` (sqlite db + per-session sandbox workdirs).
Wipe + restart for a clean slate.

## Crash recovery demo

OMA's CFless mode persists session state to SQLite + the event log on
every write, so a `kill -9` on the Node process doesn't lose the
conversation.

```bash
# 1. Create a session, drop in a few messages.
SID=$(curl -s -X POST localhost:8787/v1/sessions -d '{}' | jq -r .id)
for i in 1 2 3; do
  curl -s -X POST localhost:8787/v1/sessions/$SID/_test_emit \
    -H 'content-type: application/json' \
    -d "{\"text\":\"event-$i\"}"
done

# 2. SSE shows id:1 / id:2 / id:3 events.
curl -N localhost:8787/v1/sessions/$SID/events/stream
# (Ctrl-C to stop)

# 3. Hard-kill the server. (Or `docker compose down --no-stop` then `up`.)
docker kill oma-server -s SIGKILL

# 4. Restart.
docker compose -f docker-compose.cfless.yml up

# 5. Reconnect SSE with the last seen seq — only events after seq 3 stream.
curl -N -H 'Last-Event-ID: 3' localhost:8787/v1/sessions/$SID/events/stream
# Or `Last-Event-ID: 0` to replay everything.
```

## What works on CFless today

| Feature | Status |
|---|---|
| `/v1/agents` CRUD (create / get / list / update / version) | ✓ SQLite via SqlAgentRepo |
| `/v1/sessions` create + bind to agent | ✓ |
| `POST /v1/sessions/:id/events` (user.message → harness loop) | ✓ |
| `GET /v1/sessions/:id/events/stream` SSE w/ Last-Event-ID resume | ✓ |
| Real LLM token streaming (any Anthropic-compatible endpoint) | ✓ |
| Crash recovery on process restart | ✓ |
| `bash` tool via host subprocess | ✓ |
| `read` / `write` / `edit` / `glob` / `grep` tools | ✓ (workdir-relative) |
| `web_fetch` tool (HTML → markdown via turndown) | ✓ |
| `web_search` tool | ⏸  needs TAVILY_API_KEY env var |
| `browser` tool | ✗  CF-only (uses @cloudflare/playwright) |
| Memory stores | ⏸  port exists, Node adapter pending |
| Vault credential injection for outbound MCP / API calls | ⏸  pending |
| Multi-tenant authentication (better-auth) | ⏸  TENANT="default" hardcoded |
| Console UI | ⏸  not yet wired to main-node |

## Sandbox isolation modes

| Mode | Use when | Configuration |
|---|---|---|
| `LocalSubprocessSandbox` (default) | Local dev, trusted agent code | Nothing — host subprocess in `./data/sandboxes/<sessionId>/` |
| `E2BSandbox` | Production / untrusted code, want Firecracker microVM | Set `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY=...` (PoC: not yet wired into main-node entry — adapter exists, factory selection lands next) |
| `CloudflareSandbox` | If you happen to deploy on CF Workers + Containers | Use the regular `apps/agent` worker, not main-node |

## Architecture

```
                 Browser / curl / oma CLI
                          │
                          ▼ HTTP/SSE
              ┌──────────────────────────┐
              │  main-node (single proc) │
              │                          │
              │  • Hono routes           │
              │  • SessionRegistry       │
              │  • SqlEventLog           │
              │  • InProcessEventStreamHub│
              │  • DefaultHarness ──┐    │
              │                     │    │
              │  Sandbox: ▼         │    │
              │   subprocess|e2b    │    │
              └──────┬─────┬───────┘
                     │     │
            ┌────────┘     └─────────┐
            ▼                        ▼
        SQLite                     E2B Cloud
        ./data/oma.db              (Firecracker microVMs)
        ./data/sandboxes/         OR
                                   host /bin/sh subprocess
```

Eight runtime-agnostic ports separate "what" from "how":

  - `BlobStore`  — files/memory/workspace bytes (R2 / S3 / local FS)
  - `KvStore`    — config/snapshot key-value (CONFIG_KV / pg table / memory)
  - `SqlClient`  — SQL with batch (D1 / better-sqlite3 / postgres.js)
  - `EventLogRepo`+`StreamRepo` — per-session event durability
  - `SandboxExecutor` — code execution sandbox (CF / E2B / subprocess)
  - `ToMarkdownProvider` — web_fetch HTML→md (Workers AI / turndown)
  - `TenantDbProvider` — per-tenant DB resolution

Each port has a Cloudflare adapter and a Node adapter. The Node entry
wires the Node adapters; the CF entry wires the CF adapters. Business
code (routes, harness, store services) is the same on both.

## Production hardening (what's NOT in the PoC)

If you take this past trusted-dev territory, you'll want:

  - **Real auth.** Today every request is `tenant_id="default"`. Wire
    better-auth + the `auth.ts` middleware that apps/main uses.
  - **Vault credential injection.** The agent's bash currently runs with
    full host network access and no credential gating. Add an outbound
    proxy that intercepts HTTPS and injects vault tokens (mirrors the CF
    side's `MAIN_MCP.outboundForward` RPC).
  - **E2B (or equivalent) sandbox.** `LocalSubprocessSandbox` is a
    `chmod 777` on your host — fine for trusted dev, deadly for an agent
    a stranger can prompt-inject.
  - **Backups.** SQLite + ./data is one host. `litestream` to S3 covers
    point-in-time recovery; for higher durability, swap to Postgres.
  - **Observability.** No Analytics Engine equivalent yet. Pipe
    `pino` stdout into Loki / Grafana / your shipper of choice.
