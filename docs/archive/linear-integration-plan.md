# Linear Integration — Implementation Plan

**Companion to**: `docs/linear-integration-design.md`
**Date**: 2026-04-20

> ## Status (post-build, 2026-04-20)
>
> | Phase | Status |
> |---|---|
> | 0 — Repo prep | ✅ done |
> | 1 — `integrations-core` interfaces | ✅ done |
> | 2 — `integrations-adapters-cf` | ✅ done |
> | 3 — `apps/integrations` skeleton + wire.ts | ✅ done |
> | 4 — `packages/linear` provider | ✅ done |
> | 5 — Webhook receiver + dispatch | ✅ done |
> | 6 — Service-binding session creation | ✅ done (`/v1/internal/sessions` on main) |
> | 7 — MCP integration | ✅ done **without a custom server** — uses Linear's hosted MCP via vault outbound injection |
> | 8 — Per_issue session lifecycle | ✅ done (basic states; handoff/escalated transitions deferred) |
> | 9 — Lifecycle (handoff/reroute/escalate) | ⚠️ partial — DB states defined, transition triggers not wired |
> | 10 — Per-agent App install + setup wizard | ✅ done |
> | 11 — Setup-link admin handoff | ✅ done (7-day signed JWT + static HTML page) |
> | 12 — Console UI | ✅ done (`packages/integrations-ui` + 3 pages + Agent Detail badge + SessionsList/Detail badges) |
> | 13 — Capability matrix UI + enforcement | ⚠️ UI shipped, **enforcement not wired** (vestigial; see design addendum #2) |
> | 14 — Error/handoff comments + reauth | ❌ deferred (cross-worker; main detects error, gateway needs to post comment via vault) |
> | 15 — Observability + smoke tests | ⚠️ partial — Cloudflare observability enabled, smoke tests need real Linear creds |
>
> **Tests**: unit tests covering webhook parser, OAuth helpers, full per-agent App install, handoff link generation. All repo tests passing.
>
> **Deployment**: see `docs/linear-integration-sop.md` for the step-by-step.

This plan turns the design into a sequence of buildable, verifiable units. Each phase has a clear definition of done; phases gate on each other only where called out.

---

## Phase 0 — Repo prep

**Goal**: workspace knows about new packages and the new app.

- Add to `pnpm-workspace.yaml`:
  - `packages/integrations-core`
  - `packages/linear`
  - `packages/integrations-adapters-cf`
  - `apps/integrations`
- Each new package: `package.json`, `tsconfig.json` extending root, `src/index.ts` empty re-exports.
- Root `tsconfig.json` path aliases for new packages.
- Add `vitest.config.ts` entries (or extend the existing one) so package tests are picked up.
- Verify `pnpm install` + `pnpm typecheck` clean.

**DoD**: `pnpm typecheck` green with empty packages; `pnpm test` discovers (and skips) zero tests in the new packages.

---

## Phase 1 — `integrations-core` interfaces

**Goal**: stable contract every provider depends on. No runtime imports.

Files in `packages/integrations-core/src/`:

- `provider.ts` — `IntegrationProvider`, `InstallStep`, `InstallComplete`, `WebhookRequest`, `WebhookOutcome`, `McpScope`, `McpToolDescriptor`.
- `persistence.ts` — `InstallationRepo`, `PublicationRepo`, `WebhookEventStore`, `IssueSessionRepo`, `SetupLinkRepo`, `AppRepo`. Each with the read/write methods used by `linear` (no SQL types).
- `ports.ts` — `SessionCreator`, `Crypto`, `HttpClient`, `JwtSigner`, `Clock` (testability), `IdGenerator`.
- `domain.ts` — value types: `Installation`, `Publication`, `PublicationStatus`, `CapabilitySet`, `Persona`, `IssueSession`, `IssueSessionStatus`.
- `index.ts` — barrel export.
- `test/fakes.ts` — in-memory implementations of every port (used by `linear` tests).

**DoD**: package compiles; `test/fakes.ts` has 100% surface coverage of every port; no dependency on `cloudflare:workers`, `hono`, or any HTTP/storage runtime.

---

## Phase 2 — `integrations-adapters-cf` skeleton

**Goal**: Cloudflare-bound implementations of every port.

Files in `packages/integrations-adapters-cf/src/`:

- `crypto.ts` — `WebCryptoAesGcm` implementing `Crypto` (AES-GCM via `crypto.subtle`, key derived from injected secret).
- `jwt.ts` — `WebCryptoJwtSigner` implementing `JwtSigner` (HS256).
- `http.ts` — `WorkerHttpClient` implementing `HttpClient` (just `fetch`, with timeout + retries on 5xx/429 with backoff).
- `d1/schema.sql` — six new tables (§4 of design).
- `d1/migrations.ts` — migration runner used by `apps/main`'s existing migration tool (so we don't introduce a parallel migration system).
- `d1/installation-repo.ts`, `publication-repo.ts`, `webhook-event-store.ts` (D1 not KV — simpler and more queryable for backfill), `issue-session-repo.ts`, `setup-link-repo.ts`, `app-repo.ts`.
- `service-binding-session-creator.ts` — calls main worker via service binding.

**Decision**: webhook idempotency lives in **D1** not KV. Reasons: queryable for ops backfill; lifetime aligned with installations; one fewer binding.

**DoD**: every adapter has a unit test against an in-memory equivalent OR an integration test using `@cloudflare/workers-types` test harness; D1 migration tested via miniflare D1.

---

## Phase 3 — `apps/integrations` skeleton + `wire.ts`

**Goal**: empty gateway worker deployed and reachable; composition root in place.

- `apps/integrations/wrangler.jsonc`:
  - `name: "managed-agents-integrations"`
  - bindings: `AUTH_DB` (shared D1), `MAIN` (service binding to `managed-agents`), `MCP_SIGNING_KEY` secret.
  - `compatibility_date` matching main.
  - Custom domain route `integrations.<host>/*`.
- `src/index.ts` — Hono app with `/health` only.
- `src/wire.ts` — `buildContainer(env): Container` that returns concrete instances of every port from `integrations-adapters-cf`. Container is pure data; no globals.
- `src/env.ts` — typed `Env` matching wrangler bindings.
- Add to root deploy script.

**DoD**: `wrangler deploy` from the new app succeeds; `curl integrations.<host>/health` returns `{"status":"ok"}`; `wire.ts` instantiates without throwing.

---

## Phase 4 — `packages/linear` provider, per-agent App install flow

**Goal**: end-to-end OAuth install of a per-publication Linear App into a user's workspace, persisted in D1.

Files in `packages/linear/src/`:

- `provider.ts` — `LinearProvider implements IntegrationProvider`. Constructor takes a `Container` of ports (the same container `apps/integrations` builds). No Cloudflare imports.
- `oauth/protocol.ts` — `buildAuthorizeUrl`, `buildTokenExchangeBody`, `parseTokenResponse`.
- `graphql/client.ts` — minimal Linear GraphQL client built on the `HttpClient` port. Query helpers: `viewer`, `organization`.
- `index.ts` — exports `LinearProvider` only.

Routes in `apps/integrations/src/routes/linear/`:

- `publications.ts` — `POST /linear/publications/start-a1`, `/credentials`, `/handoff-link`.
- `dedicated-callback.ts` — `GET /linear/oauth/app/:appId/callback`.
- `setup-page.ts` — `GET /linear-setup/:token` for non-admin handoff.

**DoD**: a real OAuth install completes and creates a `linear_installations` row with `install_kind='dedicated'`; access token is encrypted at rest; revoking the App in Linear → next webhook 401 → installation marked `revoked_at`.

---

## Phase 5 — Webhook receiver + dispatch

**Goal**: real Linear webhook events arrive, get verified, deduplicated, and routed to the publication.

In `packages/linear/src/`:

- `webhook/parse.ts` — parse Linear's webhook payload into `WebhookEvent` (issue_assigned, issue_mentioned, comment_created, agent_session_event).

Route: `apps/integrations/src/routes/linear/webhook.ts` — `POST /linear/webhook/app/:appId`. Returns 200 always (Linear's contract). The webhook arrives at a publication-specific endpoint, so the binding to a publication is direct.

**DoD**: an `issueAssignedToYou` event deduplicates correctly on retry; the dedicated install resolves to its single live publication; un-routable events log but don't error.

---

## Phase 7 — Session creation via service binding

**Goal**: a routed webhook event materializes as an OMA session.

In `apps/main`:

- New endpoint: `POST /v1/internal/sessions/create-or-resume` (auth: service-binding-only via a shared signed header). Accepts `{ agent_id, user_id, metadata, initial_event }`. Creates new session OR resumes existing one matched by `metadata.linear.issue_id` for `per_issue` granularity.
- Wire `metadata.linear` into the session record; surface in SessionsList/Detail later.

In `integrations-adapters-cf`:

- `ServiceBindingSessionCreator` calls the above endpoint via the `MAIN` binding.

In `packages/linear`:

- `provider.handleWebhook` resolves publication → calls `SessionCreator.create({ agent_id, user_id, metadata, initial_event })`.
- For `per_issue`: also writes `linear_issue_sessions` so subsequent events resume.

**DoD**: a real `@OpenMA` mention in Linear creates an OMA session; subsequent comments on the same issue append to that session (per_issue mode).

---

## Phase 8 — MCP server: `get_issue` + `post_comment` (vertical slice)

**Goal**: agent can read an issue and post back a comment with persona attribution.

- Route: `apps/integrations/src/routes/linear/mcp.ts` — implements MCP protocol over HTTP (the same shape main uses for other MCP servers; reuse helpers if they exist).
- JWT validation: extract `publication_id`, `issue_id`, `session_id`, `exp`; reject mismatches.
- Tool implementations live in `packages/linear/src/tools/`:
  - `get-issue.ts`
  - `post-comment.ts` — posts comment under the App's bot identity.
- Main worker change: when starting a session triggered by Linear, inject the MCP URL + signed JWT into the session's MCP server list.

**DoD**: a published agent receives an issue mention, reads issue context, and posts a reply that renders with persona name + avatar in Linear.

---

## Phase 9 — Persona, capability check, full toolset

**Goal**: production-ready Linear toolset with capability enforcement.

- Implement remaining tools (§8 of design): `list_comments`, `search_issues`, `update_issue`, `create_issue`, `create_sub_issue`, `add_label`, `remove_label`, `assign`, `unassign`, `set_status`, `set_priority`, `delete`, `list_users`, `list_labels`, `list_statuses`, `list_projects`.
- Capability check helper in `packages/linear`: each tool calls `requireCapability(scope, "comment.write")` etc. before the GraphQL call. The capability set is part of `McpScope`, populated when the JWT is signed.
- Idempotent writes where Linear supports it (use Linear's `idempotencyKey` field on mutations).

**DoD**: every tool has at least one happy-path test against a recorded GraphQL fixture; capability denial returns a structured error the agent can read and react to.

---

## Phase 10 — `per_issue` lifecycle: handoff, reroute, escalation

**Goal**: state machine in `linear_issue_sessions` is honored on inbound events.

- Implement `human_handoff`, `rerouted`, `escalated`, `completed` transitions per §7.2.
- When agent self-unassigns, gateway updates `IssueSessionRepo.markHandoff`.
- When user reassigns issue from one agent to another, original session terminates with `rerouted`, new session starts under new publication.
- Failure tracking: count consecutive errors per session; after N (default 3), set `escalated`; surface in Console SessionsList.

**DoD**: each transition has a unit test; Linear webhooks for assignee changes correctly route to the right session lifecycle action.

---

## Phase 11 — A1 install flow (per-publication App)

**Goal**: power users can register their own Linear App and have an agent appear with full identity.

- Console UI for the publish wizard (Phase 13 also touches Console; this is the API/backend).
- Routes:
  - `POST /linear/publications/start-a1` — creates a `linear_publications` row in `pending_setup`, generates a setup token, returns copy/paste credential block (callback URL, webhook URL, suggested App name + avatar).
  - `POST /linear/publications/:id/credentials` — accepts `client_id` + `client_secret` from the user; validates by hitting Linear's introspection endpoint; transitions to `awaiting_install`; returns the install URL.
  - `GET /linear/oauth/app/:appId/callback` — handles the per-app OAuth callback; encrypts and stores `client_secret` + `access_token` + `webhook_secret`; transitions to `live`.
  - `POST /linear/webhook/app/:appId` — wired in Phase 6 with HMAC verify against this app's webhook secret.
- D1: ensure `linear_apps` row creation is atomic with publication transition.

**DoD**: a publication can be set up end-to-end via API calls (Console comes next); the resulting bot user is queryable in Linear; webhooks are received on the per-app endpoint.

---

## Phase 12 — Setup link for non-admin handoff

**Goal**: a non-admin user can hand setup off to their workspace admin via a link.

- `POST /linear/publications/:id/setup-link` — creates `linear_setup_links` row (32-byte token, 7-day expiry), returns a shareable URL.
- `GET /linear-setup/:token` — public landing (no OMA auth). Renders a minimal Hono+server-side HTML page guiding the admin through Step 2 + Step 3 of the A1 flow. On completion, marks the setup link `used_at` and notifies the original user (Console inbox; falls back to silently completing the publication state if no notification system exists).
- Rate-limit setup-link creation (one per publication per 10 min).

**DoD**: an admin (with no OMA login) can complete setup via the link; original publisher's Console reflects completion within 5 sec of admin finishing.

---

## Phase 13 — Console UI: Integrations / Linear

**Goal**: full UX from §9 of design.

- Sidebar: add "Integrations" expandable item with "Linear" child.
- Pages (React + Vite, matching existing Console patterns in `apps/console/src/pages/`):
  - `IntegrationsLinear.tsx` — workspace list, recent activity, "Publish agent" entry.
  - `IntegrationsLinearWorkspace.tsx` — per-workspace manage page.
  - `IntegrationsLinearPublishWizard.tsx` — modal/route for the publish flow.
  - `IntegrationsLinearPublication.tsx` — per-publication settings (capabilities, persona, session granularity, unpublish).
  - `IntegrationsLinearSetupHandoff.tsx` — page showing the generated setup link.
- Agent Detail badge: small status component on `AgentDetail.tsx` showing publication state with a "Manage in Integrations" link.
- Sessions UI:
  - `SessionsList.tsx`: add Linear badge column.
  - `SessionDetail.tsx`: insert Linear context card at top when session has Linear metadata.
- API client (`apps/console/src/lib/api/`): add typed methods for the new integrations endpoints.

**DoD**: every flow described in §9 works in the deployed Console; design tokens (per Multica vibe) match existing pages; manual smoke test of full publish flow passes.

---

## Phase 14 — Capability matrix UI + enforcement audit

**Goal**: make the capability system real and visible.

- UI: capability toggle list on workspace settings (baseline) and per-publication settings (further restriction). Disabled-by-workspace items shown greyed.
- Enforcement audit: walk every Linear tool implementation, ensure each calls `requireCapability` before the network call; add a unit test per tool that asserts denied calls return the documented error shape.
- Workspace capability change cascades: when a workspace baseline removes a capability, all publications under it lose it (effective set = baseline ∩ publication).

**DoD**: capability matrix UI works; flipping a workspace toggle is reflected on next agent tool call within 1 min.

---

## Phase 15 — Error / handoff comments + reauth

**Goal**: failure modes communicated cleanly to humans.

- When an agent error bubbles to session level, gateway posts an "error" comment with a structured template (§10.3).
- When an agent emits a "handoff" intent (e.g. via a tool call `linear.handoff(reason)` or session metadata flag), gateway posts a handoff comment + unassigns + marks `IssueSession` `human_handoff`.
- Reauth: when any GraphQL call returns 401/403 due to revoked token, mark publication `needs_reauth`, post a Console banner, and stop processing webhooks for it until reauthed.

**DoD**: induced failures produce the documented Linear comments; revoking an App in Linear surfaces in Console within 1 min.

---

## Phase 16 — Observability, rate limiting, smoke tests

**Goal**: ready for real workloads.

- Per-installation rate-limiter for outbound Linear API calls (token bucket, conservative initial rate; expose `Retry-After` to agent tool result).
- Webhook ingestion metrics: `received`, `verified_failed`, `dedup_hit`, `routed_to_publication`, `routed_to_session`, `dropped` (by reason). Use Cloudflare Workers Analytics Engine if available, else Logpush.
- Smoke tests (script + CI job, against a dedicated test Linear workspace): full publish flow, send mention, agent responds; capability denial; handoff.
- Runbook: `docs/linear-integration-runbook.md` covering reauth, dropped webhooks, rate-limit tuning, manual session resync.

**DoD**: smoke tests green in CI; rate limiter prevents 429 storms when an agent loops on Linear API; runbook reviewed by another maintainer.

---

## Phase ordering & critical path

```
0 → 1 → 2 → 3 → 4 ┐
                  ├→ 5 → 6 → 7 → 8 → 9 → 10 ┐
                  │                          ├→ 13 → 14 → 15 → 16
                  └→ 11 → 12 ─────────────── ┘
```

- **Critical path to first usable publication**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.
- Phases 12–15 can begin in parallel with 10–11 once the API surface is locked.

---

## Out of plan (deferred)

- Slack / GitHub providers — architecture supports them but not implemented; revisit after Linear hits stability bar (1 month in production with no P0/P1 issues).
- Linear projects / cycles / milestones as event sources.
- Bidirectional sync with `mcp.linear.app` so users in Claude Desktop can drive OMA agents.
- Browser extension.
- Multi-OMA-user shared workspace ownership.
- Per-issue capability override via label.
- Cost dashboards per publication / workspace.

---

## Open implementation questions to resolve before Phase 5

1. **Auth for `MAIN.fetch` from the gateway**: current main worker uses `authMiddleware` on `/v1/*`. Need a separate auth path for service-binding-only internal endpoints. Confirm with maintainers whether to:
   - (a) Add a header-based shared-secret check on a new `/v1/internal/*` route prefix, or
   - (b) Reuse existing API-key flow with a dedicated key for the gateway.
2. **Console framework specifics**: confirm whether to add the new pages to existing react-router setup or use a different routing strategy.
3. **MCP protocol shape**: confirm whether OMA's existing MCP integration speaks SSE, streamable HTTP, or a custom shape; align gateway's MCP server accordingly.
4. **Notification system**: does `apps/main` expose anything for in-app notifications (for setup-link-completed pings)? If not, fall back to Console polling for v1.

These should be answered before Phase 5; resolution may shift Phase 7 (auth) and Phase 13 (Console) details.
