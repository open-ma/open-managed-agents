# Linear Integration — Design

**Status**: Draft (brainstorm output, pending implementation plan)
**Date**: 2026-04-20
**Author**: open-managed-agents contributors

> ## Implementation reality (post-build addendum, 2026-04-20)
>
> The implementation diverged from this spec in a few places. Read this before the rest of the doc — what's below is the original design intent.
>
> 1. **No custom MCP server.** §6/§8 originally described a gateway-hosted Linear MCP server (~500 LoC of tool definitions + JSON-RPC dispatch). At build time we realized we could just point the agent's existing `mcp_servers` config at Linear's hosted MCP (`https://mcp.linear.app/mcp`) and inject the access token transparently via OMA's outbound vault mechanism. **Net code: 0 lines of MCP server.**
>
> 2. **Capability enforcement is vestigial.** §6 describes per-publication capability restriction. Without our own MCP proxy, capability checks have nowhere to live — the agent talks straight to Linear's hosted MCP. The capability set is stored in DB and editable in the UI but **does not actually restrict** anything in v1.
>
> 3. **Token at rest still encrypted; in-flight via vault, not gateway-MCP.** Linear access token is stored AES-GCM encrypted in `linear_installations`, copied into a per-installation OMA vault credential matched against `mcp.linear.app` hostname. The sandbox's existing outbound Worker injects the bearer header. Sandbox never sees the token. Spec security goals are met.
>
> 4. **Console UI ships in `packages/integrations-ui`.** New package with its own React/JSX tsconfig, excluded from root `tsc`. apps/console mounts pages via thin wrappers (e.g. injecting `loadAgents` for the publish wizard).
>
> 5. **Public vs Private** for the per-agent App is up to the publisher; Private is the default for self-hosted single-workspace use.
>
> 6. **Internal endpoint auth.** Gateway endpoints called via service binding from main require `X-Internal-Secret` header. main and gateway must share the same `INTEGRATIONS_INTERNAL_SECRET`.
>
> 7. **Storage debt acknowledged.** Most OMA entities (sessions, agents, environments, vaults) live in KV. KV has no real indexes. New tables added by this integration (`linear_*`) live in D1, which is the right home; future migration of legacy KV → D1 is a separate effort.

---

## 1. Summary

This document specifies a Linear integration for Open Managed Agents (OMA). The integration lets users turn their OMA agents into **Linear teammates** — agents become real users in a Linear workspace, can be `@`-mentioned, assigned issues, post comments, change status, and otherwise participate in issue threads as if they were human members.

Each agent registers its own Linear OAuth App and appears as a distinct first-class Linear user with autocomplete and assignee-dropdown presence ("full identity").

A new Cloudflare Worker (`apps/integrations`) acts as the gateway between Linear and the existing OMA platform, hosting OAuth flows, webhook receivers, and an MCP server that exposes Linear API tools to agents at runtime.

---

## 2. Motivation & Goals

### 2.1 What we're building

OMA today is a meta-harness for AI agents — users define agents (config: model, system prompt, tools), spin up sessions, and run them via API or Console. There is no integration with the team's existing collaboration surface.

For teams already using Linear for issue tracking, the natural way to delegate to an AI agent is to do it the same way they delegate to a human — `@`-mention or assign. This integration makes that possible.

### 2.2 Goals

- **G1**: A user with an existing OMA agent can publish it to a Linear workspace such that the agent becomes a teammate (mentionable, assignable, can comment, can change status).
- **G2**: The setup is achievable by a non-engineer in under 5 minutes.
- **G3**: Agent identity in Linear is per-agent (not a shared "OMA bot"), supporting the "agents as colleagues" framing.
- **G4**: All Linear-side traffic is centralized in a separate Cloudflare Worker (`apps/integrations`) so the existing main worker remains focused on the platform's first-party API.
- **G5**: Linear API tokens never reach agent sandboxes; they are held only by the gateway and accessed via a scoped MCP server.
- **G6**: Architectural foundation generalizes to future integrations (Slack, GitHub, Discord) by adding new providers under `apps/integrations/providers/`.

### 2.3 Non-Goals

- Building a Linear competitor or replicating Linear-like UI inside OMA (Multica's approach).
- Customer-request intake, project/cycle/milestone-driven workflows (v1).
- Multiple OMA users sharing ownership of the same Linear workspace install (v1: single owner per install).
- A browser extension that augments Linear's UI with virtual `@` autocomplete entries.
- Mobile push notifications from OMA.

---

## 3. Architecture Overview

```
┌──────────────┐  webhook  ┌──────────────────────────┐  service ┌──────────────┐
│   Linear     │──────────▶│ apps/integrations        │  binding │  apps/main   │
│  Workspaces  │◀──────────│ gateway worker            │─────────▶│  + sandbox   │
└──────────────┘  GraphQL  │ integrations.<host>       │          └──────────────┘
                            └─────────┬────────────────┘                ▲
                                      │  MCP (HTTP) Linear tools         │
                                      └──────────────────────────────────┘
```

### 3.1 Package layering (dependency inversion)

The integration is split into four packages so that **provider logic** (Linear-specific behavior) is decoupled from both the **runtime** (Cloudflare Workers) and the **storage** (D1/KV). The composition root — `apps/integrations` — wires concrete implementations into abstract ports defined by `packages/integrations-core`. This keeps Linear logic testable without spinning up workerd, lets us add Slack / GitHub providers without touching the gateway worker code, and prevents Linear specifics from leaking into the platform's main worker.

```
                     ┌──────────────────────────────────────┐
                     │  packages/integrations-core           │
                     │  (abstract interfaces only,           │
                     │   no Cloudflare, no Linear)           │
                     │                                       │
                     │  - IntegrationProvider                │
                     │  - WebhookValidator port              │
                     │  - InstallationRepo / PublicationRepo │
                     │  - WebhookEventStore (idempotency)    │
                     │  - SessionCreator port                │
                     │  - McpToolRegistry                    │
                     │  - Crypto port (AES-GCM)              │
                     └─────────┬───────────────┬─────────────┘
                               │               │
                  implements   │               │   implements
                               ▼               ▼
        ┌────────────────────────────┐   ┌───────────────────────────────┐
        │  packages/linear           │   │  packages/integrations-       │
        │  (provider impl, pure)     │   │  adapters-cf                  │
        │                            │   │  (Cloudflare-specific impl)   │
        │  - LinearProvider          │   │                               │
        │  - GraphQL client          │   │  - D1Installation/PublicationRepo
        │    (depends on HTTP port)  │   │  - KvWebhookEventStore        │
        │  - HMAC validator          │   │  - ServiceBindingSessionCreator│
        │  - Routing rules           │   │  - WebCryptoAesGcm            │
        │  - createAsUser injection  │   │  - WorkerHttpClient           │
        │  - Linear MCP tools        │   │                               │
        └─────────────┬──────────────┘   └─────────────┬─────────────────┘
                      │                                │
                      └────────────┬───────────────────┘
                                   │ both consumed by
                                   ▼
                     ┌──────────────────────────────────────┐
                     │  apps/integrations                    │
                     │  (composition root, thin)             │
                     │                                       │
                     │  - Hono routes                        │
                     │  - wire.ts: instantiate adapters,     │
                     │    inject into LinearProvider         │
                     │  - Cloudflare env / bindings          │
                     └──────────────────────────────────────┘
```

**Dependency direction (strict)**:

- `integrations-core` depends on nothing in this design (only `packages/shared` types).
- `linear` depends only on `integrations-core` and `packages/shared`. It must not import `cloudflare:workers`, `hono`, D1 types, or anything runtime-specific.
- `integrations-adapters-cf` depends only on `integrations-core` and Cloudflare runtime APIs.
- `apps/integrations` depends on all three. It owns no domain logic; it just instantiates and wires.

This means:

- `LinearProvider` can be unit-tested with in-memory fake repos and a fake HTTP client.
- A future Slack provider lives at `packages/slack/`, implementing the same `IntegrationProvider` interface, and the gateway adds a one-liner in `wire.ts`.
- If we ever migrate off Cloudflare for the gateway (or want to host the MCP server inside `apps/main` for local dev), only `integrations-adapters-cf` needs replacement.

### 3.2 Composition root: `apps/integrations`

A standalone Cloudflare Worker, deployed at `integrations.<host>`, separate from `apps/main`. It is a **thin** worker — Hono routes plus a composition root (`wire.ts`) that builds adapters and providers from the bindings. It contains no Linear-specific logic and no business rules.

Responsibilities:

- Mount Hono routes for OAuth (install, callback), webhook ingestion, setup-link handoff, MCP server, and a `/health` endpoint.
- In `wire.ts`: construct concrete adapter instances (D1 repos, KV idempotency store, service-binding session creator, AES-GCM crypto) and inject them into `LinearProvider`.
- Expose the wired `IntegrationProvider` instances under `/<provider>/...` route prefixes. Adding a new provider is a `wire.ts` line plus route registration.

```
apps/integrations/
└── src/
    ├── index.ts            Hono app, route registration
    ├── env.ts              Cloudflare bindings type
    ├── wire.ts             composition root
    └── routes/
        ├── health.ts
        └── linear/
            ├── install.ts
            ├── callback.ts
            ├── webhook.ts
            ├── setup-link.ts
            └── mcp.ts
```

### 3.3 Bindings

```
apps/integrations bindings:
- AUTH_DB             (D1, shared with main; new tables added)
- INTEGRATIONS_KV     (KV; for OAuth state, webhook idempotency, setup-link tokens)
- MAIN                (service binding to main worker for session creation)
- MCP_SIGNING_KEY     (secret; signs JWTs delivered to agents)
```

### 3.4 Request lifecycle

**OAuth install (per-agent App):**
1. User in Console clicks "Publish agent".
2. Console calls main worker to create a `linear_publication` record in `pending_setup` state.
3. Main returns a setup token; user is shown copy/paste credentials and a deep link to Linear's developer settings.
4. User registers an App in Linear, posts back `client_id`/`client_secret` to OMA via the integrations worker.
5. Integrations worker validates credentials by performing a test OAuth handshake; on success, the publication moves to `awaiting_install` and the user clicks an install link.
6. Linear redirects to integrations worker's callback; the worker exchanges the code for an access token (using the **per-publication** client credentials), encrypts it, stores it in `linear_apps`, and marks the publication `live`.

**Webhook event:**
1. Linear POSTs to `integrations/linear/webhook/app/<app_id>`.
2. Worker validates HMAC against the install's webhook secret.
3. Worker checks `delivery_id` against `linear_webhook_events` for idempotency.
4. The webhook arrives at a publication-specific endpoint, so the binding to a publication is direct.
5. Worker calls `MAIN.fetch("/v1/sessions", ...)` to create or resume an OMA session, attaching Linear context (workspace, issue, comment) as session metadata.
6. Worker writes the session id back into `linear_webhook_events`.

**Agent → Linear callback (during session):**
1. Main worker injects an MCP server URL into the agent session, signed with `MCP_SIGNING_KEY` and scoped to the publication + issue.
2. Agent calls Linear tools via MCP. The integrations worker validates the JWT, looks up the publication's access token, and proxies the call to Linear's GraphQL API.

### 3.5 Core abstractions (`packages/integrations-core`)

The interfaces below are the contract every provider must satisfy. They are deliberately runtime-agnostic — no Cloudflare types, no Linear types — so providers can be unit-tested with in-memory fakes.

```ts
// packages/integrations-core/src/provider.ts
export interface IntegrationProvider {
  readonly id: string; // 'linear', future: 'slack', 'github', ...

  /** Given a publication in pending_setup, return the next-step UI payload. */
  startInstall(input: StartInstallInput): Promise<InstallStep>;

  /** Continue install when the user posts back credentials / completes OAuth. */
  continueInstall(input: ContinueInstallInput): Promise<InstallStep | InstallComplete>;

  /** Verify and dispatch a webhook payload. Returns the provider-resolved publication. */
  handleWebhook(req: WebhookRequest): Promise<WebhookOutcome>;

  /** Return the MCP tool descriptors a published agent gets at session time. */
  mcpTools(scope: McpScope): Promise<McpToolDescriptor[]>;

  /** Execute a tool call from the agent's session. */
  invokeMcpTool(scope: McpScope, toolName: string, input: unknown): Promise<unknown>;
}

// packages/integrations-core/src/persistence.ts
export interface InstallationRepo {
  get(id: string): Promise<Installation | null>;
  findByWorkspace(providerId: string, workspaceId: string, kind: InstallKind): Promise<Installation | null>;
  insert(row: NewInstallation): Promise<Installation>;
  markRevoked(id: string): Promise<void>;
}
export interface PublicationRepo {
  get(id: string): Promise<Publication | null>;
  listByInstallation(installationId: string): Promise<Publication[]>;
  insert(row: NewPublication): Promise<Publication>;
  updateStatus(id: string, status: PublicationStatus): Promise<void>;
  updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void>;
}
export interface WebhookEventStore {
  /** Returns true if delivery_id is new (and recorded), false if duplicate. */
  recordIfNew(deliveryId: string, installationId: string, eventType: string): Promise<boolean>;
  attachSession(deliveryId: string, sessionId: string): Promise<void>;
}
export interface IssueSessionRepo { /* per_issue session bookkeeping */ }
export interface SetupLinkRepo { /* admin-handoff tokens */ }

// packages/integrations-core/src/ports.ts
export interface SessionCreator {
  create(input: CreateSessionInput): Promise<{ sessionId: string }>;
  resume(sessionId: string, event: SessionEventInput): Promise<void>;
}
export interface Crypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
export interface HttpClient {
  fetch(req: HttpRequest): Promise<HttpResponse>;
}
export interface JwtSigner {
  sign(payload: object, ttlSec: number): Promise<string>;
  verify(token: string): Promise<object>;
}
```

`packages/linear/` implements `IntegrationProvider` and depends only on these ports. `packages/integrations-adapters-cf/` implements the ports against Cloudflare primitives (D1, KV, service binding, Web Crypto, fetch).

### 3.6 Bindings → adapter mapping

Each Cloudflare binding is wrapped by exactly one adapter that satisfies a port. No provider reads bindings directly.

| Binding | Adapter | Port |
|---|---|---|
| `AUTH_DB` (D1) | `D1InstallationRepo`, `D1PublicationRepo`, `D1IssueSessionRepo`, `D1SetupLinkRepo`, `D1AppRepo` | `*Repo` |
| `INTEGRATIONS_KV` | `KvWebhookEventStore` | `WebhookEventStore` |
| `MAIN` (service binding) | `ServiceBindingSessionCreator` | `SessionCreator` |
| `MCP_SIGNING_KEY` (secret) | `WebCryptoJwtSigner` | `JwtSigner` |
| Worker `fetch` | `WorkerHttpClient` | `HttpClient` |
| Web Crypto API | `WebCryptoAesGcm` | `Crypto` |

`apps/integrations/src/wire.ts` is the only file that knows about both layers.

---

## 4. Data Model

All tables live in `AUTH_DB` (D1). Schema migrations live with `packages/integrations-adapters-cf` (the Cloudflare-specific adapter), not in `apps/integrations` and not in `packages/linear` — the provider package never sees SQL.

### 4.1 `linear_apps` (per-publication App credentials)

```sql
CREATE TABLE linear_apps (
  id              TEXT PRIMARY KEY,           -- uuid
  publication_id  TEXT NOT NULL UNIQUE,       -- 1:1 with publication
  client_id       TEXT NOT NULL,              -- from Linear App registration
  client_secret   TEXT NOT NULL,              -- AES-GCM encrypted at rest
  webhook_secret  TEXT NOT NULL,              -- AES-GCM encrypted
  created_at      INTEGER NOT NULL
);
```

### 4.2 `linear_installations`

```sql
CREATE TABLE linear_installations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,              -- OMA user (better-auth user.id)
  workspace_id    TEXT NOT NULL,              -- Linear org id
  workspace_name  TEXT NOT NULL,
  install_kind    TEXT NOT NULL,              -- 'dedicated' (single value retained for forward-compat)
  app_id          TEXT,                       -- FK linear_apps.id
  access_token    TEXT NOT NULL,              -- AES-GCM encrypted
  refresh_token   TEXT,                       -- AES-GCM encrypted (if Linear issues one)
  scopes          TEXT NOT NULL,
  bot_user_id     TEXT NOT NULL,              -- Linear user id of the App bot
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  UNIQUE (workspace_id, install_kind, app_id)
);
```

Each App registration gets its own row.

### 4.3 `linear_publications`

```sql
CREATE TABLE linear_publications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,          -- OMA user (publisher)
  agent_id            TEXT NOT NULL,          -- OMA agent
  installation_id     TEXT NOT NULL,          -- FK linear_installations.id
  mode                TEXT NOT NULL,          -- 'full'
  status              TEXT NOT NULL,          -- 'pending_setup' | 'awaiting_install' | 'live' | 'needs_reauth' | 'unpublished'
  persona_name        TEXT NOT NULL,          -- displayed in Linear (App name)
  persona_avatar_url  TEXT,                   -- App avatar
  capabilities        TEXT NOT NULL,          -- JSON: which Linear ops this publication may perform
  session_granularity TEXT NOT NULL,          -- 'per_issue' | 'per_event'
  created_at          INTEGER NOT NULL,
  unpublished_at      INTEGER
);
```

### 4.4 `linear_webhook_events`

```sql
CREATE TABLE linear_webhook_events (
  delivery_id     TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  publication_id  TEXT,                       -- nullable: may not have routed yet
  event_type      TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  processed_at    INTEGER,
  session_id      TEXT,                       -- triggered session
  error           TEXT
);
```

### 4.5 `linear_setup_links`

```sql
CREATE TABLE linear_setup_links (
  token           TEXT PRIMARY KEY,           -- random, 32 bytes
  publication_id  TEXT NOT NULL,
  created_by      TEXT NOT NULL,              -- OMA user_id
  expires_at      INTEGER NOT NULL,           -- 7 days from creation
  used_at         INTEGER,
  used_by_email   TEXT
);
```

### 4.6 `linear_issue_sessions`

Mapping of Linear issues to OMA sessions, used for `per_issue` granularity to find the existing session on subsequent webhooks.

```sql
CREATE TABLE linear_issue_sessions (
  publication_id  TEXT NOT NULL,
  issue_id        TEXT NOT NULL,              -- Linear issue id
  session_id      TEXT NOT NULL,              -- OMA session id
  status          TEXT NOT NULL,              -- 'active' | 'completed' | 'human_handoff' | 'rerouted' | 'escalated'
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (publication_id, issue_id)
);
```

---

## 5. Identity Strategy

### 5.1 Full identity (per-agent App)

Each `linear_publication` has its own `linear_apps` row with dedicated OAuth credentials. The bot user created when that App is installed in a workspace **is** the agent's identity. Linear's `@` autocomplete and assignee dropdown surface the bot like any other user.

**Setup cost**: ~3 minutes per agent per workspace (Linear App registration must be done by a workspace admin).

**Capabilities at the protocol level**: standard `actor=app` OAuth with the requested scopes (`read`, `write`, `app:assignable`, `app:mentionable`, plus any others the user grants).

Routing is implicit (event arrives at a publication-specific webhook endpoint, so the binding to a publication is direct).

### 5.2 Non-admin handoff

Non-admin OMA users cannot complete setup themselves (Linear requires workspace admin to register Apps). The Console offers a "Send setup link to admin" action that creates a `linear_setup_links` row and surfaces a shareable URL.

The admin opens the link, lands on a minimal setup page hosted by the gateway (no OMA login required, just the link's token), completes Linear-side steps, and the credentials flow back into the originating publication. The original user is notified.

---

## 6. Capability Model

### 6.1 Default

All Linear API operations are enabled by default. This includes:

- Read all content
- Comment / reply
- Change `status`, `labels`, `priority`, `assignee` (incl. others), `project`, `milestone`
- Create issues / sub-issues
- `@`-mention real humans
- Self-unassign
- Delete issues / comments

Rationale: matches the "agent is a teammate" framing; if an agent has bad behavior the fix is to update its system prompt or unpublish it, not to gate it at the API layer.

### 6.2 Restriction model

Two-tier opt-out:

- **Workspace baseline** (`linear_installations.capabilities`): cap on what any publication in this workspace can do.
- **Per-publication** (`linear_publications.capabilities`): may restrict further than the workspace baseline; cannot extend beyond it.

The MCP server enforces capability checks before every Linear API call.

UI: Settings page per workspace shows toggle list; each publication's settings page shows the same list with workspace-disabled items greyed.

---

## 7. Session Model

### 7.1 Granularity options

Set per-publication via `session_granularity`:

- **`per_issue`** (default): All events on a given Linear issue map to a single OMA session. The session accumulates context as comments and status changes happen. Backed by `linear_issue_sessions`.
- **`per_event`**: Each webhook event creates a fresh session. Agent has no built-in memory across events; can use `memory_store` if persistence is needed.

### 7.2 Session lifecycle states

In `linear_issue_sessions.status`:

- `active`: agent currently working or idle awaiting next event
- `completed`: issue closed; session archived
- `human_handoff`: agent self-unassigned; session idle, awaiting human action
- `rerouted`: user reassigned issue to different agent; session terminated, new session may be started by the new publication
- `escalated`: N consecutive failures; session held; surfaced in Console as needing human attention

### 7.3 Rebuilding context after crash

OMA's existing crash recovery applies: the session's event log is the source of truth, and on next webhook the harness rebuilds context from the log. The Linear context is reattached from `linear_issue_sessions` + a fresh `get_issue` call.

---

## 8. Linear Tools (MCP)

The gateway hosts an MCP server at `https://integrations.<host>/mcp/linear?token=<jwt>`. The JWT is signed by `MCP_SIGNING_KEY`, scoped to a single publication + issue, and short-lived (session-bounded).

### 8.1 Tools

```
linear.get_issue(id)
linear.list_comments(issue_id)
linear.search_issues(query)
linear.list_users()
linear.list_labels()
linear.list_statuses()
linear.list_projects()
linear.post_comment(issue_id, body)
linear.update_issue(id, fields)
linear.create_issue(...)
linear.create_sub_issue(parent_id, ...)
linear.add_label(id, label)
linear.remove_label(id, label)
linear.assign(id, user_id)
linear.unassign(id, user_id)
linear.set_status(id, status_id)
linear.set_priority(id, priority)
linear.delete(id)
```

### 8.2 Tool schemas

Auto-generated from Linear's GraphQL schema introspection. A single source of truth for tool definitions reduces drift.

---

## 9. Console UX

### 9.1 Sidebar

Add `Integrations` as a top-level item with `Linear` as its child. Future providers (`Slack`, `GitHub`) will be siblings of `Linear`.

### 9.2 Integrations / Linear page

Single source of truth for all Linear configuration:

- List of linked workspaces (with mode badges and live agent counts)
- "+ Publish agent to Linear" entry point
- Cross-agent recent activity feed
- Per-workspace "Manage" deep link

### 9.3 Publish flow

A 3-step modal:

1. **Pick agent** — choose the OMA agent to publish.
2. **Setup** — copy/paste Linear App credentials; "Send to admin" alternative.
3. **Done** — confirmation with deep link back to the workspace in Linear.

### 9.4 Workspace manage page

Per-workspace view: connection status, list of live publications, "+ Publish another agent", "Disconnect workspace" (cascades to all publications under this install).

### 9.5 Per-publication settings

Capabilities matrix, persona overrides (name/avatar), session granularity, unpublish.

### 9.6 Agent Detail page

Minimal change: a Linear status badge with a "Manage in Integrations" link. All actual configuration happens in the Integrations page.

### 9.7 Sessions

- `SessionsList`: rows triggered by Linear show a `🔗 Linear` badge plus workspace name on hover.
- `SessionDetail`: a Linear context card at the top with issue title, link back to Linear, and recent comment preview.

---

## 10. Linear-side UX

Agents appear as first-class Linear users:

- `@` autocomplete shows the persona name
- Assignee dropdown lists them
- Notification text uses the persona name ("Coder commented on ENG-142")
- Issue sidebar Agent Session panel shows live activity, scoped to the agent

### 10.1 Error / handoff comments

When an agent fails or hands off, it posts a structured comment:

```
⚠️ Hit an error while working on this:
"<short error description>"

Will retry in <duration>. If this keeps happening, see the OMA dashboard.
[ Open in OMA ↗ ]
```

```
I'm not sure how to proceed — <short reason>. Unassigning so a human can take it.
```

---

## 11. Security

- **Webhook authentication**: HMAC-SHA256 verification against per-install webhook secret. Constant-time compare. Reject on mismatch.
- **Webhook idempotency**: `delivery_id` checked against `linear_webhook_events`; duplicate deliveries return 200 immediately.
- **Token at rest**: Linear access tokens, refresh tokens, client secrets, and webhook secrets are encrypted in D1 using AES-GCM with a key derived from `MCP_SIGNING_KEY` (or a separate secret if rotation policy requires).
- **Token never reaches sandbox**: agents have no direct access to Linear tokens. All Linear calls go through the gateway's MCP server, authenticated by short-lived JWTs scoped to a single publication + issue.
- **JWT scope**: includes `publication_id`, `issue_id`, `session_id`, `exp`. The MCP server rejects calls outside this scope.
- **Capability enforcement**: every Linear write goes through a capability check against the publication's effective capability set (workspace ∩ publication).
- **Setup-link security**: setup-link tokens are 32-byte random, single-use, expire in 7 days, and grant only the ability to complete one specific publication's setup. They do not grant OMA login.

---

## 12. Out of Scope (v1)

- Slack, GitHub, Discord providers (architecture leaves room under `apps/integrations/providers/`).
- Linear projects / cycles / milestones / initiatives as event sources (agents can still operate on these objects via tools).
- Customer requests / feedback intake.
- Bidirectional sync with Linear MCP server (`mcp.linear.app`).
- Mobile push notifications from OMA.
- Multi-OMA-user shared ownership of a Linear workspace install (single owner per install in v1; ownership transfers via support flow).
- Per-issue capability override label (e.g. `agent:read-only` to temporarily downscope).
- Cost attribution dashboards per publication / per workspace.

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Linear API rate limit (≈1500 req/h/workspace) | Agents block on bursty workloads | Token bucket per installation in gateway; expose remaining quota to agent via tool result; surface in SessionDetail |
| Webhook delivery loss | Missed events, stale agent state | Linear retries on its side; idempotency table on ours; "Resync issue" manual button per `linear_issue_sessions` row |
| Linear App count limit per workspace | A1 unusable past a threshold | Limit not publicly documented; add a UI cap (e.g. 20) and surface a link to Linear support if hit |
| Workspace admin refuses setup | Power user blocked | Setup-link flow encourages async coordination with admin |
| Linear API/UI changes | Integration breaks | Linear's Agents API is GA but Agent Plans is in preview; pin to documented endpoints; add integration smoke tests; treat preview features as best-effort |
| Token leak | Workspace compromise | AES-GCM encryption at rest, gateway-only access, short JWT scope, audit log on Linear side via `actor=app` attribution |
| User uninstalls App in Linear | Webhooks 401 | Gateway marks publication `needs_reauth`; Console shows red banner with reauth CTA |
| User unpublishes an A1 agent | Linear App orphaned | Gateway revokes the install via Linear API; the App registration in Linear's developer settings remains under the user's control to delete manually |

---

## 14. Implementation Notes for the Plan Phase

The implementation plan (next phase) should respect the package layering — interfaces first, then provider implementation, then adapters, then wiring. Sequence:

**Phase A — Foundations (no Linear yet)**
1. `packages/integrations-core` skeleton with the interfaces in §3.5 and shared types. No runtime deps.
2. `packages/integrations-adapters-cf` skeleton: D1/KV/service-binding/Web-Crypto adapters implementing the ports. Unit-tested against in-memory fakes from `integrations-core/test`.
3. D1 migrations for the six new tables, owned by the cf-adapters package.
4. `apps/integrations` skeleton: `wrangler.jsonc`, `/health`, `wire.ts` composition root, deployed at `integrations.<host>`.

**Phase B — Linear provider (per-agent App, end-to-end)**
5. `packages/linear` skeleton implementing `IntegrationProvider`, depending only on `integrations-core` ports.
6. Per-publication App install flow: setup wizard, validation, install link.
7. Setup-link handoff for non-admin users.
8. Webhook receiver: HMAC validation in `packages/linear`, idempotency via `WebhookEventStore` adapter; arrives on per-app endpoint, so binding to publication is direct.
9. `SessionCreator` adapter calls main worker; provider attaches Linear context.
10. Linear MCP integration: agent's `mcp_servers` config points at Linear's hosted MCP (`https://mcp.linear.app/mcp`); access token injected via OMA's outbound vault. No custom MCP server.
11. `per_issue` session granularity via `IssueSessionRepo`.

**Phase C — Console + completeness**
12. Console UI: Integrations page, workspace list, publish wizard, workspace manage page, per-publication settings.
13. Agent Detail badge + SessionsList badge + SessionDetail Linear context card.
14. Full Linear tool set in the MCP server.
15. Capability matrix UI + enforcement (in `packages/linear` against the capability set carried in `McpScope`).
16. Error / handoff structured comments.
17. Reauth flow when token revocation is detected.
18. Integration smoke tests, observability, rate-limit protection.

**Test layering**
- `packages/integrations-core`: unit tests for type guards, helper logic.
- `packages/linear`: unit tests with in-memory fake repos + a recorded GraphQL fixture HTTP client. No workerd needed.
- `packages/integrations-adapters-cf`: integration tests against miniflare-style D1/KV bindings.
- `apps/integrations`: thin route-level smoke tests; most logic is exercised by the package tests above.
