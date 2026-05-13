# Architecture: Meta-Harness Design

> "We're opinionated about the shape of these interfaces, not about what runs behind them."
> — [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)

## What is a Meta-Harness

Managed Agents is itself a **meta-harness** — not a specific agent implementation, but a platform that defines stable interfaces for any agent to use. It's unopinionated about _which_ harness Claude needs, but opinionated about the primitives every harness requires:

1. **Session** — an append-only event log for durable state
2. **Sandbox** — a compute environment where tools execute
3. **Vault** — secure credential storage, never exposed to sandboxes

A harness is pluggable. The platform provides capabilities; the harness provides strategy.

## Three Layers

```
┌─────────────────────────────────────────────────────────┐
│  Harness (pluggable agent loop)                         │
│  - Reads events, builds context, calls Claude           │
│  - Decides HOW to use tools, skills, cache, compaction  │
│  - Stateless: crash → wake(sessionId) → resume          │
├─────────────────────────────────────────────────────────┤
│  Meta-Harness / Platform (SessionDO)                    │
│  - Defines interfaces: session, sandbox, vault          │
│  - Prepares WHAT is available: tools, skills, history   │
│  - Manages lifecycle: sandbox warmup, event persistence │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (Cloudflare primitives)                  │
│  - Durable Objects + SQLite (session storage)           │
│  - Containers (sandbox execution)                       │
│  - KV + R2 (config, files, credentials)                 │
└─────────────────────────────────────────────────────────┘
```

## Platform vs. Harness Responsibilities

The dividing line: **the platform prepares _what is available_, the harness decides _how to deliver it_ to the model.**

### Platform (SessionDO) prepares:

| Responsibility | Interface |
|---|---|
| Register tools from agent config | `buildTools(agent, sandbox) → tools` |
| Mount skill files into sandbox | `sandbox.writeFile('/home/user/.skills/...')` |
| Build memory tools from store IDs | `buildMemoryTools(storeIds, kv) → tools` |
| Manage sandbox lifecycle | `getOrCreateSandbox()`, `warmUpSandbox()` |
| Persist events durably | `history.append(event)` |
| Broadcast to WebSocket clients | `broadcastEvent(event)` |
| Track session status | `idle → running → idle` |
| Handle harness crash recovery | catch error → `session.error` → return to idle |

### Harness (agent loop) decides:

| Responsibility | Why it's a harness concern |
|---|---|
| System prompt construction | Different harnesses need different personas |
| Cache strategy | Where to put `cache_control: ephemeral` breakpoints |
| Compaction strategy | When to compress, what to keep (summarize vs. sliding window) |
| Context engineering | How to transform events into messages, ordering, filtering |
| Retry strategy | How many retries, what counts as transient, backoff curve |
| Tool delivery | All tools at once vs. progressive disclosure |
| Step handling | What to broadcast on each step (thinking, tool_use, message) |
| Stop conditions | When the agent is "done" (max steps, user.message_required, etc.) |

## Key Interfaces

### Session Interface

```typescript
interface HistoryStore {
  getMessages(): CoreMessage[];       // Events → AI SDK message format
  append(event: SessionEvent): void;  // Durable write to SQLite
  getEvents(afterSeq?: number): SessionEvent[];  // Positional slicing
}
```

The event log enables:
- **Crash recovery**: `wake(sessionId)` → `getEvents()` → rebuild context → resume
- **Replay**: New WebSocket clients receive full event history
- **Flexibility**: Harness can rewind, skip, or transform events before passing to Claude

### Sandbox Interface

```typescript
interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
}
```

Every tool, including MCP servers, reduces to `execute(name, input) → string`. The harness never knows whether the sandbox is a Cloudflare Container, a local process, or a mock — it just calls the interface.

### HarnessContext (what the platform gives to the harness)

```typescript
interface HarnessContext {
  agent: AgentConfig;              // Model, system prompt, tool config
  userMessage: UserMessageEvent;   // The trigger message
  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    CONFIG_KV?: KVNamespace;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
  };
  runtime: {
    history: HistoryStore;         // Read/write the event log
    sandbox: SandboxExecutor;      // Execute commands, read/write files
    broadcast: (event: SessionEvent) => void;  // Push to WebSocket clients
    reportUsage?: (input: number, output: number) => Promise<void>;
    abortSignal?: AbortSignal;     // User interruption
  };
}
```

## The Brain is Stateless

A harness holds no state. Everything it needs comes from:
1. The **event log** (conversation history)
2. The **agent config** (model, tools, system prompt)
3. The **sandbox** (file system, running processes)

When a harness crashes:
1. SessionDO catches the error
2. Emits `session.error` event
3. Sets status back to `idle`
4. Next `user.message` creates a fresh harness instance
5. New harness reads event log, rebuilds context, continues

Nothing is lost because events are durably written to SQLite before being broadcast.

## The Hands are Cattle

Containers are interchangeable. A failed container can be replaced with `provision({resources})` — same packages installed, same files mounted, fresh state.

Key design decisions:
- **Lazy provisioning**: Containers are created on first tool call, not at session start. Sessions that don't need code execution skip the container cost entirely.
- **Parallel start**: Inference begins immediately from the event log. Container provisioning happens in background. By the time Claude makes its first tool call, the container is usually ready.
- **No credentials in the harness or sandbox**: Vault credentials live exclusively in the main worker. Both the harness (cloud DO / local daemon) and the sandbox container only ever know `(tenantId, sessionId, serverName | hostname)` — they ask main to make the actual MCP / outbound HTTPS call on their behalf, and main looks up the credential live (no per-session snapshot) and injects the bearer just before forwarding upstream. This mirrors [Anthropic Managed Agents' "credential proxy outside the harness"](./mcp-credential-architecture.md) pattern; a prompt-injected agent has no credential to leak because there is none in its address space. Full details + threat model in [mcp-credential-architecture.md](./mcp-credential-architecture.md).

## Implications for Custom Harnesses

Because the platform handles infrastructure, a custom harness is simple:

```typescript
class ResearchHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    // Platform already prepared: tools, skills, sandbox, history
    // I just decide HOW to use them

    const messages = ctx.runtime.history.getMessages();
    // My custom context engineering: keep all web_search results
    // but summarize tool_result blocks aggressively

    const result = await generateText({
      model: resolveModel(ctx.agent.model, ctx.env.ANTHROPIC_API_KEY),
      messages: myCustomTransform(messages),
      tools: ctx.tools,  // Already built by platform
      maxSteps: 50,      // Research needs more steps
    });
  }
}
```

A coding harness might use plan-then-execute with aggressive caching.
A data analysis harness might use streaming with custom compaction that preserves DataFrames.
A research harness might use web search with citation tracking.

All of them get the same tools, skills, sandbox, and history from the platform. They differ only in strategy.

## Current Implementation Notes

Our `DefaultHarness` currently mixes some platform concerns (tool building, skill mounting) that should ideally be in SessionDO's context preparation. This is tracked as technical debt — the harness works correctly, but custom harness authors currently need to duplicate this setup code. A future refactor would move tool/skill preparation into `HarnessContext` construction so harnesses receive a fully-prepared context.

## Package Layering (P2 — shared HTTP routes + supporting abstractions)

CF Workers (`apps/main`) and self-host Node (`apps/main-node`) used to write
their HTTP route bodies twice — once against D1/KV/R2/SEND_EMAIL, once
against SqlClient/SqlKvStore/LocalFsBlobStore/nodemailer. The duplicated
layer was extracted into eight runtime-agnostic packages plus one route
package mounted by both apps:

| Package | Purpose | Adapters |
|---|---|---|
| `@open-managed-agents/schema` | One canonical `applySchema` for the OMA tables, idempotent on sqlite + PG. | — |
| `@open-managed-agents/email` | `EmailSender` interface; `null` is valid (signals "no SMTP, mount email-disabled better-auth flows"). | `cf` (SEND_EMAIL), `nodemailer` |
| `@open-managed-agents/kv-store/adapters/sql` | KvStore on top of SqlClient (`kv_entries` table). Companion to existing `cf` + `in-memory` adapters. | sqlite + PG via SqlClient |
| `@open-managed-agents/quotas` | `QuotaService` — daily session cap, upload freq, upload size. KV + RateLimitGate-backed. | KV-agnostic |
| `@open-managed-agents/rate-limit` | `RateLimitGate` interface + `gates` bundle (5 named buckets). Hono middleware factory. | `cf` (Workers Rate Limiting bindings), `memory` (in-process token bucket) |
| `@open-managed-agents/auth` | Hono auth middleware factory — apiKey + cookie session resolution, x-active-tenant validation, AUTH_DISABLED bypass. | Resolvers injected per-runtime |
| `@open-managed-agents/auth-config` | `buildBetterAuth` factory + tenant auto-create hook + `ensureTenantSqlite`. | Driver injected |
| `@open-managed-agents/vault-forward` | `buildAuthHeader`, `refreshMcpOAuth`, `forwardWithRefresh` (401-then-refresh pure transport). | Pluggable fetcher |
| `@open-managed-agents/http-routes` | Hono `mountXxxRoutes(app, services)` factories: agents / vaults / sessions / memory / tenants / me / api_keys. Same paths CF mounts today; behavior preserved. The sessions package routes the runtime layer through the `SessionRouter` interface (see below). | Runtime constructs `RouteServices` bundle |
| `@open-managed-agents/session-runtime` | `SessionStateMachine` + `RuntimeAdapter` (Phase 2) plus `SessionRouter` — uniform contract over the per-runtime session routing layer. CF impl wraps the SessionDO RPC surface; Node impl wraps `SessionRegistry` + `SqlEventLog` + `EventStreamHub`. | `apps/main/src/lib/cf-session-router.ts`, `apps/main-node/src/lib/node-session-router.ts` |
| `@open-managed-agents/sandbox/orchestrator` | `SandboxOrchestrator` — single entry point both runtimes use to provision a session sandbox: vault outbound (HTTPS_PROXY + CA), `/mnt/memory` mounts, `/mnt/session/outputs` mount, optional workspace backup/restore. Replaces the per-runtime plumbing that lived separately in `apps/agent/src/oma-sandbox.ts` and `apps/main-node/src/registry.ts`. Per-provider capability matrix lives in `docs/self-host.md`. | `DefaultSandboxOrchestrator` (both runtimes); CF wires the OmaSandbox + R2 squashfs backup; Node wires `NodeWorkspaceBackupService` (tar+upload to BlobStore). |

`apps/main-node/src/index.ts` is now ~280 lines: build the SqlClient,
construct services, mount route bundles, start the server. The previous
1664-line inline-routes implementation is gone.

`apps/main/src/index.ts` mounts agents / vaults / sessions / api-keys /
me / tenants from `@open-managed-agents/http-routes`. The legacy
`apps/main/src/routes/{agents,vaults,sessions,api-keys,me,tenants}.ts`
files are deleted; CF-only callbacks (USAGE_METER gate, GitHub fast-path
token mint, `refreshProviderCredentialsForSession`, R2 outputs cascade,
shard assignment, AUTH_DB membership reads) are passed in as `lifecycle`
hooks + `services` callbacks so the package stays runtime-agnostic. The
remaining CF-specific routes (`/v1/internal`, `/v1/integrations`,
`/billing-api/*`, `/agents/runtime/_attach`, cron + queue handlers) stay
in CF apps regardless — they depend on Durable Objects / service
bindings / R2 Event Notifications that have no Node analog yet.

## References

- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents) — Anthropic engineering blog
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview) — API documentation
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — Skills architecture
