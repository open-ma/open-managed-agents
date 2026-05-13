# OMA Deployment Topologies

Three ways to run Open Managed Agents. Pick by where you want the operator's
risk + ops burden to land. The agent code itself doesn't change between them
— each store / sandbox / event log lives behind a port, and the right adapter
is wired at startup.

| Mode | One-liner | When to pick |
|---|---|---|
| **Self-host** | `docker compose up` (or `pnpm --filter main-node start`) — single Node process + sqlite/pg + LocalSubprocess sandbox + `oma-vault` sidecar | Self-host, Fly.io / Render / VPS, no Cloudflare account, full control over data + binaries |
| **CF local** | `pnpm dev` — `wrangler dev` on the main + agent workers with local D1/KV/R2/DO simulators | Develop against the CF runtime without touching prod; tests; one-off prod-shape repro |
| **CF prod** | `pnpm deploy` (`scripts/deploy.sh`) — three workers (main / agent / integrations) on Cloudflare's network | Production at scale; you want CF to handle scaling, durability, edge presence; OK with vendor lock-in |

This doc covers each end-to-end and shows the matrix at the bottom so you can
diff at a glance.

---

## Self-host

**One process, one box.** Everything runs in a single Node process, with
optional sidecar (`oma-vault`) for outbound credential injection.

```
                     ┌──────── browser / curl / SDK ───────┐
                     │                                      │
                     ▼                                      ▼
              ┌──────────────────────────────────────────────┐
              │  oma-server (apps/main-node)                 │
              │                                              │
              │  • Hono on Node, port 8787                   │
              │  • better-auth (sqlite-backed) → /api/auth/* │
              │  • REST + SSE → /v1/*                        │
              │  • SqlClient (better-sqlite3 OR postgres.js) │
              │  • SqlEventLog + InProcessEventStreamHub     │
              │  • LocalFsBlobStore + chokidar watcher       │
              │  • DefaultHarness (apps/agent shared code)   │
              │  • SandboxExecutor: subprocess|litebox|...   │
              └──────────────────────┬───────────────────────┘
                                     │ subprocess (default)
                          ┌──────────┴──────────┐
                          ▼                     ▼
                  ./data/sandboxes/<sid>/   HTTPS_PROXY=http://oma-vault:14322
                       (host fs)                  │
                                                  ▼
                                    ┌──────────────────────────┐
                                    │ oma-vault (apps/oma-vault)│
                                    │ mockttp HTTPS MITM proxy  │
                                    │ inject Authorization      │
                                    └──────────────────────────┘
                                                  │
                                                  ▼
                                          api.github.com etc.
```

### Components

| Concern | Implementation |
|---|---|
| HTTP server | Hono on `@hono/node-server`, port 8787 |
| SQL store | `better-sqlite3` (default, `./data/oma.db`) OR `postgres.js` (set `DATABASE_URL=postgres://...`) |
| KV | not used at the API layer — agents/env config lives in the SQL `agents`/`environments` tables |
| Blob store | `LocalFsBlobStore` (`./data/memory-blobs/<storeId>/<path>`); operator can swap in an S3 adapter when scaling |
| Event log | `SqlEventLog` (per-session events in shared `session_events` table) + `InProcessEventStreamHub` (sqlite mode) or `PgEventStreamHub` (pg mode, LISTEN/NOTIFY-backed) for SSE fan-out |
| Sandbox | `SANDBOX_PROVIDER=subprocess` (default, no isolation), `litebox` (Firecracker μVM), `daytona`, `e2b` |
| Auth | `better-auth` on a separate `./data/auth.db` (sqlite). Email + password by default; Google OAuth optional. `AUTH_DISABLED=1` bypasses for single-user demos |
| Vault credential injection | `apps/oma-vault` sidecar — mockttp HTTPS MITM proxy with self-signed CA. Reads vault credentials from the same sqlite db |
| Memory mount | sandbox symlinks `/mnt/memory/<storeName>` → `<MEMORY_BLOB_DIR>/<storeId>/`. chokidar watcher reflects fs writes back into the SQL `memories` index |
| Cron | not wired yet (TODO: `node-cron` adapter for the per-tenant memory retention pass) |
| Queue | not used — chokidar watcher replaces the R2-event Queue consumer |
| Console UI | embedded in main-node image (`apps/console/dist` served by `serveStatic` middleware on the same `:8787` port, with SPA fallback). Skippable via `--build-arg SKIP_CONSOLE=1` for API-only image. `vite dev` mode also supported for live-reload |
| Observability | `console.log` / `pino` (operator pipes stdout to Loki / Grafana) |

### Start

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env  # ANTHROPIC_API_KEY + BETTER_AUTH_SECRET

# 2. Run (Docker compose: oma-server + oma-vault)
docker compose -f docker-compose.yml up --build

# 3. Sanity
curl localhost:8787/health
# → {"status":"ok","runtime":"node","auth":"better-auth",...}

# 4. Sign up
curl -c cookies.txt -X POST localhost:8787/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"hunter2-test1234","name":"You"}'

# 5. Drive an agent
AID=$(curl -b cookies.txt -X POST localhost:8787/v1/agents \
  -H 'content-type: application/json' \
  -d '{"name":"shell","model":"claude-haiku-4-5-20251001","tools":[{"type":"agent_toolset_20260401"}]}' \
  | jq -r .id)
SID=$(curl -b cookies.txt -X POST localhost:8787/v1/sessions \
  -H 'content-type: application/json' -d "{\"agent_id\":\"$AID\"}" | jq -r .id)
curl -b cookies.txt -X POST localhost:8787/v1/sessions/$SID/events \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"echo hi"}]}]}'
curl -N -b cookies.txt localhost:8787/v1/sessions/$SID/events/stream
```

### Without Docker

```bash
pnpm install
ANTHROPIC_API_KEY=sk-... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  pnpm --filter @open-managed-agents/main-node start
# Same curl flow as above against localhost:8787.
```

### Hard limits

- SQLite mode: single process, single writer. To horizontally scale,
  switch to PG mode (`DATABASE_URL=postgres://...`).
- PG mode: `oma-server` itself is replica-safe (PG LISTEN/NOTIFY hub
  fans events out across replicas; `upsertFromEvent` is idempotent on
  sha256 etag). Caveats: `MEMORY_BLOB_DIR` must be on shared storage
  (NFS/EFS/shared docker volume); `auth.db` and `oma-vault` are still
  single-process (deferred). See `docs/self-host.md#running-multiple-oma-server-replicas-pg-mode-only`.
- `LocalSubprocessSandbox` has zero isolation — `rm -rf /` from a
  prompt-injected agent hits the host. Switch to `litebox` or `daytona`
  for untrusted code.
- No browser tool — `@cloudflare/playwright` is CF-only.

---

## CF Local (`wrangler dev`)

**`wrangler dev` on three workers** with local D1 / KV / R2 / DO / Queue
simulators. Identical-shape to prod; same code, same bindings, just no
network presence.

```
       ┌── browser / oma CLI ──┐
       │                        │
       ▼                        ▼
  ┌────────────────────┐
  │ wrangler dev       │   ports 8787 (main), 8788 (agent)
  │  ├─ apps/main      │
  │  │   └─ Hono routes
  │  │   └─ assets binding → apps/console/dist (SPA)
  │  │   └─ DO: RuntimeRoom
  │  │   └─ R2 binding (local sim)
  │  │   └─ KV binding (local sim)
  │  │   └─ D1 binding (local sim)
  │  │   └─ Queue consumers (local sim, no R2 events though)
  │  │   └─ Service binding → SANDBOX_sandbox_default → agent worker
  │  └─ apps/agent (separate worker process)
  │      └─ DO: SessionDO + Sandbox (Container)
  │      └─ Service binding → MAIN_MCP → main worker
  └────────────────────┘
```

### Components

| Concern | Implementation |
|---|---|
| HTTP server | Workers runtime via wrangler dev, ports 8787/8788 |
| SQL store | D1 local simulator (sqlite under the hood). Same migration files as prod |
| KV | wrangler local KV simulator |
| Blob store | wrangler local R2 simulator |
| Event log | DO storage SQL (per-DO sqlite namespace) |
| Sandbox | `@cloudflare/sandbox` Container DO running locally via Docker |
| Auth | `better-auth` against the local D1 simulator |
| Vault credential injection | `MAIN_MCP.outboundForward` RPC — agent's container HTTPS calls go through main worker which injects header |
| Memory mount | R2 simulator + sandbox.mountBucket(localBucket: true) sync |
| Cron | wrangler dev `--test-scheduled` flag triggers crons manually |
| Queue | wrangler dev simulates queues but R2 Event Notifications do NOT fire (control-plane feature). Agent writes to memory don't audit in dev — known limitation |
| Console UI | served by main worker's ASSETS binding from `apps/console/dist` (SPA fallback) |
| Observability | wrangler dev tails to stdout |

### Start

```bash
# Build console once
pnpm build:console

# Start both workers (main + agent) — wrangler dev with --persist-to ./.wrangler
pnpm dev
# → main worker on :8787, agent worker on :8788

# Sanity
curl localhost:8787/health
```

### Hard limits

- R2 Event Notifications don't fire in dev (CF control-plane feature). Agent
  fs writes to /mnt/memory don't update the SQL memories index in dev mode
  — REST writes still do. This is a CF-side limitation, not OMA's.
- Container sandboxes need Docker running locally.
- Cron triggers don't fire automatically — use `--test-scheduled`.

---

## CF Prod

**Three workers on Cloudflare's network.** main + agent + integrations,
each with its own bindings, deployed via `wrangler deploy`.

```
                     ┌──── *.openma.dev (CF Anycast) ────┐
                     │                                     │
                     ▼                                     ▼
       ┌────────────────────────────┐         ┌─────────────────────────┐
       │ managed-agents (main)      │         │ managed-agents-           │
       │                            │         │   integrations            │
       │  • Hono routes             │         │  • Linear OAuth           │
       │  • DO: RuntimeRoom         │         │  • GitHub App             │
       │  • Service binding ──┐     │ ◄──── service ──── /v1/integ/* ──┤
       │  • Queue consumers   │     │                                  │
       │  • Cron triggers     │     │                                  │
       └──┬─────────┬────┬────┘     └─────────────────────────────────┘
          │         │    │
          ▼         ▼    │
        D1        R2     │ service binding
       AUTH_DB  MEMORY    ▼
                         ┌──────────────────────────────┐
                         │ sandbox-default (agent)      │
                         │  • DO: SessionDO + Sandbox   │
                         │  • Container per session     │
                         │  • Browser binding           │
                         │  • Cross-script DO →         │
                         │     RuntimeRoom (in main)    │
                         │  • Service binding →         │
                         │     MAIN_MCP (vault inject)  │
                         └──────────────────────────────┘
```

### Components

| Concern | Implementation |
|---|---|
| HTTP server | Cloudflare Workers, anycast at openma.dev |
| SQL store | D1 (`openma-auth` DB; `staging` env has `openma-auth-staging`) |
| KV | `CONFIG_KV` — agent config snapshots, outbound URL→cred map, session secrets |
| Blob store | R2 — `managed-agents-files`, `managed-agents-memory`, `managed-agents-workspace`, `managed-agents-backups` |
| Event log | SessionDO sqlite (per-DO) |
| Sandbox | `@cloudflare/sandbox` Container DO — Firecracker on CF Containers |
| Auth | `better-auth` on D1, email + password + Google OAuth + email OTP. Email via CF Email Workers (`SEND_EMAIL` binding) |
| Vault credential injection | `MAIN_MCP.outboundForward` RPC. agent's container HTTPS goes through main worker via `outboundByHost` callback. Zero-trust: agent never sees secret |
| Memory mount | R2-FUSE via `@cloudflare/sandbox` `mountBucket()`. R2 Event Notifications → `managed-agents-memory-events` queue → consumer in main worker → D1 audit |
| Cron | `* * * * *` cron in main worker (env-image build poll, base-snapshot maintenance) |
| Queue | `managed-agents-memory-events` + DLQ; queue consumer in main worker reflects R2 events to D1 |
| Console UI | static assets served by main worker's `ASSETS` binding (`apps/console/dist`); SPA fallback for client-side routing |
| Browser tool | `@cloudflare/playwright` against the agent worker's `BROWSER` binding |
| Observability | Analytics Engine — `oma_events` dataset; `pino` JSON logs to `wrangler tail` |
| Rate limiting | CF Workers Rate Limiting binding (`ratelimits`) — OTP / auth abuse |

### Deploy

```bash
# All deploys go through scripts/deploy.sh:
#   1. Read svcbind:* keys from CONFIG_KV → list of sandbox-* worker names
#   2. Generate apps/main/wrangler.jsonc with service bindings populated
#   3. Upload new versions
#   4. Smoke-test (curl /health)
#   5. Activate (wrangler deploy)
pnpm deploy

# Or piecewise:
./scripts/deploy.sh upload-only   # versions, don't activate
./scripts/deploy.sh deploy-only   # activate previously uploaded
```

### Hard limits

- Vendor lock-in: D1 / R2 / DO / Queues / AI / Browser / Containers all
  CF-only. No straight migration off without porting.
- DO single-isolate-per-id is a strength (no distributed locking) and a
  weakness (debugging the hot DO is hard; no cross-isolate visibility).
- Container sandboxes have CF Containers limits — `instance_type=lite`,
  cold-start cost, max concurrency.
- D1 has 100GB max DB size; sharding via `tenant-dbs-store` for scale-out.
- R2 Event Notifications eventually-consistent — D1 audit lags wall clock
  by seconds in steady state.

---

## Side-by-side matrix

| Concern | Self-host | CF Local | CF Prod |
|---|---|---|---|
| Process count | 1 (oma-server) + 1 sidecar (oma-vault) | 2 wrangler dev (main + agent) | 3 workers (main + agent + integrations) |
| HTTP runtime | Hono on Node | workerd | workerd at edge |
| SQL store | better-sqlite3 / postgres.js | D1 local sim | D1 (with optional shard router) |
| KV / cache | none — SQL covers it | wrangler KV sim | CONFIG_KV |
| Blob | LocalFsBlobStore (`./data`) | R2 local sim | R2 buckets |
| Event log | SqlEventLog (shared SQL) | DO sqlite | DO sqlite |
| Stream broadcast | InProcessEventStreamHub (sqlite) or PgEventStreamHub (pg, LISTEN/NOTIFY) for SSE | DO WS hibernation → SSE bridge | DO WS hibernation → SSE bridge |
| Sandbox | subprocess / litebox / daytona / e2b | Container DO via Docker | Container DO on CF Containers |
| Auth | better-auth + sqlite (own file) | better-auth + D1 local sim | better-auth + D1 + Email Workers + OAuth |
| Vault inject | oma-vault sidecar (mockttp MITM) | MAIN_MCP.outboundForward RPC | MAIN_MCP.outboundForward RPC |
| Memory mount | symlink to LocalFsBlobStore + chokidar | R2 sim + mountBucket(localBucket:true) | R2 + s3fs + R2 Events → Queue → D1 |
| Cron | TODO (node-cron) | wrangler dev `--test-scheduled` | CF cron `* * * * *` |
| Queue | none (chokidar replaces it) | wrangler queue sim | CF Queues + DLQ |
| Browser tool | not supported | wrangler dev BROWSER sim (limited) | @cloudflare/playwright |
| Email | nodemailer (set SMTP_HOST/PORT/USER/PASS) — null sender mounts no email-bearing better-auth flows | wrangler dev SEND_EMAIL sim | CF Email Workers |
| Console | embedded in main-node image, served by `serveStatic` on `:8787` (or `vite dev` proxy mode for live-reload) | served by main worker ASSETS | served by main worker ASSETS |
| Rate limit | in-process token bucket via `@open-managed-agents/rate-limit/adapters/memory` (5-bucket bundle) | wrangler dev ratelimits sim | CF Rate Limiting binding |
| HTTP routes (CRUD) | `@open-managed-agents/http-routes` mount factories | (CF mounts existing per-app files; package mount migration is staged) | (same) |
| Observability | stdout (pino) | wrangler tail stdout | Analytics Engine + wrangler tail |
| Start cmd | `docker compose up` | `pnpm dev` | n/a (run-as-deployed) |
| Deploy cmd | `docker compose up -d` | n/a (dev only) | `pnpm deploy` |
| Multi-tenant | better-auth + tenant/membership tables | better-auth + tenant/membership tables | better-auth + tenant/membership tables + shard router |
| Multi-instance | sqlite: no — single writer. pg: yes — LISTEN/NOTIFY fanout (shared `MEMORY_BLOB_DIR` required; auth.db + oma-vault still 1-proc) | n/a | scales by default |

## Picking a topology

- **Building OMA features** → CF Local. Closest to prod, fast iteration.
- **Self-hosting OMA on your own infra** → Self-host. Single binary,
  predictable costs, no CF account needed.
- **Running OMA at scale for users** → CF Prod. The whole stack was built
  for this; the self-host mode is the "you can leave if you want" escape
  hatch, not the optimization target.

## Cross-topology contracts

The same `Services` container is built on every topology:

```typescript
const services = buildServices(env);
// On self-host this returns sqlite/pg-backed adapters.
// On CF (local + prod) this returns D1/R2/KV-backed adapters.
// Routes / harness / store services treat them identically.
```

Same goes for `SandboxExecutor`, `BlobStore`, `KvStore`, `SqlClient`,
`EventLogRepo`, `StreamRepo`, `ToMarkdownProvider`. Each port has CF + Node
adapters; the entry picks one. This is the contract that makes "swap CF
for plain Node" possible without forking the harness or routes.
