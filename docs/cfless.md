# CFless OMA — single-process Node deployment

A Node-side build of Open Managed Agents that runs on a single VPS / Mac /
Docker host without any Cloudflare account, Workers, Durable Objects, or
Containers. Storage is SQLite + local filesystem. Sandboxes are local
subprocesses by default; switch to E2B for Firecracker isolation when
you're past trusted-developer territory.

> **One of three deployment topologies.** See [deployment.md](./deployment.md)
> for the full Local CFless / CF Local / CF Prod comparison + decision
> matrix. This doc covers Local CFless specifically.

> **Status:** Working PoC. The CFless route is a parallel implementation of
> the same `Services` abstractions used on Cloudflare, including better-auth
> multi-tenant. See "What works / doesn't" below.

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

## Postgres backend

The default compose puts everything in SQLite. For multi-instance deploys,
larger sessions tables (50M+ rows), or to share an existing PG cluster,
use the Postgres compose:

```bash
docker compose -f docker-compose.cfless.pg.yml up --build
curl localhost:8787/health
# → {"status":"ok","backends":{"agents":"postgres","events":"postgres","db":"postgres ..."}}
```

What changes vs the SQLite stack:

- `oma-server` reads `DATABASE_URL=postgres://oma:oma@postgres:5432/oma`
  (set in `docker-compose.cfless.pg.yml`); the same SqlClient port serves
  every store package, so business code is identical.
- `oma-vault` follows the same dispatch — when `DATABASE_URL` is a
  postgres URL the sidecar reads credentials from PG (otherwise it falls
  back to the bundled SQLite path).
- A `postgres:16-alpine` service ships with the compose, persisted on a
  named volume `oma-pgdata`. No host port published; only `oma-server`
  reaches it on the bridge network. Add `ports: ["5432:5432"]` if you
  want `psql` access from the host.
- `better-auth` still sits on its own SQLite file at `/app/data/auth.db`
  — the kysely-adapter wants a node-postgres `Pool`, not the
  `postgres.js` driver this codebase uses for the main store. It's a
  small file (<1k rows) and the `./data` bind-mount keeps it co-located
  with backups.

To point at an existing PG (instead of the bundled `postgres` service),
remove the `postgres` service block and override `DATABASE_URL` /
`oma-vault.DATABASE_URL` in `.env`:

```bash
DATABASE_URL=postgres://user:pw@my-pg.internal:5432/oma_prod
```

Both backends pass the same crash-recovery test surface (55 tests across
adapter / recovery-logic / SIGKILL bootstrap / CF DO eviction).

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
| Memory stores (mount + agent fs writes → SQL index) | ✓ symlink + chokidar watcher |
| Vault credential injection for outbound MCP / API calls | ✓ via `oma-vault` sidecar |
| Postgres backend (DATABASE_URL=postgres://...) | ✓ same code path as SQLite |
| Multi-tenant authentication (better-auth) | ✓ email+password + OTP, AUTH_DISABLED=1 escape |
| Console UI (vite dev or built `dist`) | ✓ talks to main-node via `/auth/*` + `/v1/*` |

## Sandbox isolation modes

| Mode | Use when | Configuration |
|---|---|---|
| `LocalSubprocessSandbox` (default) | Local dev, trusted agent code | Nothing — host subprocess in `./data/sandboxes/<sessionId>/`. `SANDBOX_PROVIDER=subprocess` (the default). |
| `DaytonaSandbox` | Production / untrusted code with managed VMs | `SANDBOX_PROVIDER=daytona`, `DAYTONA_API_KEY=...`, optional `DAYTONA_API_URL` (self-hosted) and `SANDBOX_IMAGE=node:22-slim`. Vault CA uploaded into the box on first exec; memory mount via `MEMORY_S3_*` env vars (s3fs installed by the adapter). |
| `LiteBoxSandbox` | Local hardware isolation without docker | `SANDBOX_PROVIDER=litebox`, optional `LITEBOX_MEMORY_MIB`, `LITEBOX_CPUS`, `SANDBOX_IMAGE`. BoxLite ships its own Firecracker runtime (no daemon). Memory mounts work via host bind-mount; vault CA copied into VM on first exec. |
| `E2BSandbox` | Firecracker microVM SaaS | `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY=...`, optional `SANDBOX_IMAGE` (template id). Memory via `MEMORY_S3_*` env vars (same s3fs setup as Daytona). |
| `CloudflareSandbox` | If you happen to deploy on CF Workers + Containers | Use the regular `apps/agent` worker, not main-node. |

## Vault credential injection (oma-vault sidecar)

When the sandbox's bash runs `curl https://api.github.com/...`, OMA injects
the matching vault credential as an `Authorization: Bearer ...` header
without ever exposing the token to the agent process. This mirrors the CF
build's `outboundByHost` + `MAIN_MCP.outboundForward` zero-trust pattern.

How it works:

```
sandbox bash
  ├── HTTPS_PROXY=http://oma-vault:14322
  ├── NODE_EXTRA_CA_CERTS=/app/data/oma-vault-ca/ca.crt
  ├── SSL_CERT_FILE=/app/data/oma-vault-ca/ca.crt
  └── curl https://api.github.com/user
              │
              ▼
       oma-vault (mockttp HTTPS MITM proxy)
       ├── Strip incoming Authorization (zero-trust)
       ├── Look up credential matching api.github.com host
       ├── Inject Authorization: Bearer <vault token>
       └── Forward to upstream
                  │
                  ▼
           api.github.com  ← sees real Authorization header
```

Set up:

```bash
# 1. Create a vault.
VID=$(curl -s -X POST localhost:8787/v1/vaults \
  -H 'content-type: application/json' \
  -d '{"name":"github-prod"}' | jq -r .id)

# 2. Add a static_bearer credential bound to api.github.com.
curl -s -X POST localhost:8787/v1/vaults/$VID/credentials \
  -H 'content-type: application/json' \
  -d '{
    "display_name":"github-pat",
    "auth":{
      "type":"static_bearer",
      "token":"ghp_xxx",
      "mcp_server_url":"https://api.github.com"
    }
  }'

# 3. Run an agent. Its bash `curl https://api.github.com/user` will see
#    the credential injected; the model never sees the raw token.
```

The CA at `./data/oma-vault-ca/ca.crt` is regenerated on first vault
start and persisted across restarts. Sandboxes mounted with the shared
`./data` volume pick it up automatically through `OMA_VAULT_CA_CERT`.

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

## Console UI

The same `apps/console` build that ships with CF prod talks to main-node.
Auth path is `/auth/*` (matches CF), data routes are `/v1/*`. Cookie auth
via better-auth.

**Two ways to serve it:**

### Single port (production / `docker compose up`)

The main-node Docker image embeds `apps/console/dist` and main-node's
`serveStatic` middleware mounts it at `"*"` with index.html SPA fallback.
Open `http://localhost:8787` and you get the Console — same port as the
API. CF prod has the equivalent via the `ASSETS` binding; same UX,
different mechanism.

```bash
docker compose -f docker-compose.cfless.yml up -d
open http://localhost:8787
```

To skip the console build (smaller API-only image, ~250MB → ~245MB):

```bash
docker build -f apps/main-node/Dockerfile --build-arg SKIP_CONSOLE=1 \
  -t openma/main-node:api-only .
# then unset CONSOLE_DIR in your runtime env
```

### Vite dev server (development)

Hot-reload on console source changes. main-node still runs separately
on 8787; vite proxies `/v1` + `/auth` to it.

```bash
# Terminal 1: main-node
ANTHROPIC_API_KEY=sk-... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=http://localhost:5173 \
  pnpm --filter @open-managed-agents/main-node start

# Terminal 2: console (Vite dev server, proxies /v1 + /auth → :8787)
VITE_API_TARGET=http://localhost:8787 pnpm dev:console
# → http://localhost:5173

# Terminal 3 (optional): oma-vault — outbound credential injection
DATABASE_PATH=$(pwd)/data/oma.db OMA_VAULT_CA_DIR=$(pwd)/data/oma-vault-ca \
  pnpm --filter @open-managed-agents/oma-vault start
```

Open `http://localhost:5173` (dev) or `http://localhost:8787` (docker),
sign up via email + password. The verification OTP is printed to
main-node's stdout — paste into the console verify-signup screen.
Operators wiring real email replace the `sendVerificationOTP` callback
in `apps/main-node/src/auth/config.ts` with a Resend / SES / SMTP call.

Endpoints main-node implements for the console:
- `/auth-info` (provider list)
- `/auth/*` (better-auth: sign-up, sign-in, sign-out, get-session, OTP)
- `/v1/me`, `/v1/me/tenants`
- `/v1/agents` CRUD, `/v1/sessions` CRUD + events + SSE stream
- `/v1/memory_stores` + `/memories` + per-session bindings
- `/v1/vaults` + `/credentials`
- `/v1/models/list`

Endpoints stubbed (return empty `data: []` so the UI degrades gracefully):
- `/v1/environments`, `/v1/api_keys`, `/v1/me/cli-tokens`,
  `/v1/runtimes`, `/v1/skills`, `/v1/model_cards`
- `/v1/integrations/{github,linear,slack}/*`

These pages render an "empty" state in the console; their CF counterparts
will land in main-node as follow-up work.

## Production hardening (what's NOT in the PoC)

If you take this past trusted-dev territory, you'll want:

  - **Real auth.** Today every request is `tenant_id="default"`. Wire
    better-auth + the `auth.ts` middleware that apps/main uses.
  - **E2B (or equivalent) sandbox.** `LocalSubprocessSandbox` is a
    `chmod 777` on your host — fine for trusted dev, deadly for an agent
    a stranger can prompt-inject.
  - **Backups.** SQLite + ./data is one host. `litestream` to S3 covers
    point-in-time recovery; for higher durability, swap to Postgres.
  - **Observability.** No Analytics Engine equivalent yet. Pipe
    `pino` stdout into Loki / Grafana / your shipper of choice.
