# Linear Integration — Current Architecture (post M7)

**Status**: Live, this is what's in code as of 2026-04-23
**Predecessor**: [`linear-integration-design.md`](./linear-integration-design.md) — original design, partly superseded; read for historical context

---

## TL;DR

Bot is a first-class Linear teammate. **All Linear-visible output goes through explicit MCP tool calls** — there is no auto-mirror of the bot's internal reasoning. The bot decides what to surface, what to keep private, and when to finalize a panel. Server side is two D1 tables and an MCP server. No mutating per-turn state in KV. No event-tap.

---

## The mental model

```
                   Linear
                   ──────
                     │
        webhooks ↓   │ ↑ GraphQL (tool-driven)
                     │
       ┌─────────────┼─────────────────────────────────────┐
       │  apps/integrations (gateway worker)              │
       │  ┌──────────────────┐  ┌────────────────────┐   │
       │  │  webhook router  │  │  MCP server        │   │
       │  │  /linear/webhook │  │  /linear/mcp/:sess │   │
       │  │  parse + route   │  │  3 tools           │   │
       │  └────────┬─────────┘  └─────────▲──────────┘   │
       └───────────│─────────────────────│───────────────┘
                   │                     │
                   │ user.message         │ tool call
                   ▼                     │
       ┌──────────────────────────────────────────────────┐
       │  apps/main (OMA)  →  apps/agent (SessionDO)      │
       │  bot lives here, decides via tools when to speak │
       └──────────────────────────────────────────────────┘
```

Two channels:
- **Input** (Linear → bot): webhooks parsed and dispatched as `user.message` into the bot's OMA session
- **Output** (bot → Linear): bot calls MCP tools to publish anything user-visible

There is no auto-mirror layer. Bot's internal `thought` / `tool_use` events stay in OMA; nothing reaches Linear unless the bot calls a tool.

---

## Tool surface (3)

### `linear_say(body, panelId, kind, action?, parameter?)`

Post an `AgentActivity` to a Linear panel. This is how the bot speaks visibly inside a panel.

| `kind` | Panel state after | Use case |
|---|---|---|
| `thought` *(default)* | stays `active` | "checking the code…", progress narration |
| `action` | stays `active` | structured tool-call card (pass `action`, optional `parameter`) |
| `elicitation` | flips to `awaitingInput` | ask the panel creator a question, inline reply box renders |
| `response` | flips to `complete` | final answer, **panel is dead** afterward |

**Sequence rules:**
- After `kind=elicitation`, do not post anything else to the same panel until the user replies — Linear is showing the input box, more activity overrides it.
- After `kind=response`, the panel is dead. API accepts further activities but UI doesn't render them. Linear will spawn a new panel for the user's next interaction.

**`panelId`** is named explicitly in the user-message that woke the bot (e.g. `Linear panel ag_xxx for this turn`). Bot threads it through.

### `linear_post_comment(body, parentId?, issueId?)`

Post a Linear comment as the bot user. Independent of any panel.

- Omit `parentId` → top-level comment (starts a new thread). Use to reach a different person via `@`-mention.
- Pass `parentId` → thread reply. Linear thread structure is flat (2 levels), so every reply parents to the original top-level comment.
- `issueId` defaults to the issue this conversation is bound to.
- `@`-mention via plain `@<displayname>` — Linear server-side parses to a real mention chip + sends notification.

If a human replies in a thread the bot started, the reply arrives back as the next user message.

### `linear_get_issue(issueId?, parentCommentId?)`

Read an issue's full state plus its comment history (up to 50 comments). Pass `parentCommentId` to scope to one thread (parent + replies).

Returns: identifier, title, description, status, priority, labels, assignee, creator, URLs, plus the comment list.

Use when bot wakes with thin context, when state may have changed, or before referencing past comments.

---

## Trigger sources (3 webhook → user.message paths)

### 1. `agentSessionCreated`

Fired when:
- Linear UI: someone delegates an issue to the bot, or someone `@`-mentions the bot
- API: `agentSessionCreateOnIssue` mutation called server-side (our test workaround)

`user.message` carries:
```
# Linear agent session — newly opened
**Issue:** OPE-25
**Issue UUID:** `...`  ← use this when a tool wants issueId
**Actor:** @hrhrngxy
**Linear panel:** `ag_xxx`
**Title:** ...
**Description:** ...
**Source comment:** ... (if delegated via @-mention in a comment)
[hint: linear_say(..., panelId="ag_xxx", kind=...) to speak in the panel]
```

### 2. `agentSessionPrompted`

Fired when the panel creator replies in the panel's inline reply box (after a previous `kind=elicitation`).

Same shape as #1 but header reads "new prompt" and `Source comment` carries the user's reply.

### 3. `commentReply`

Fired when a human posts a thread reply on a comment the bot authored. Routed via `linear_authored_comments` D1 lookup.

`user.message` carries:
```
# Linear thread reply
**Issue:** OPE-23
**Issue UUID:** `...`
**Thread anchor comment:** <bot's original comment id>
**Replier:** @hrhrngxy
> <reply body, quoted>
[hint: linear_post_comment(body=..., parentId="<anchor>") to respond in the thread]
```

There's no panel for this turn; bot must use `linear_post_comment` for visible output.

### Not triggered (intentional)

- Comment by anyone where parent isn't in `linear_authored_comments` → kind=null, dropped
- Issue field changes (status / labels / title) → ignored
- Bot's own comments (`actorUserId === installation.botUserId`) → dropped to prevent self-loop

(Future iteration may add an "ambient observation" channel — see Limitations below.)

---

## Server-side state

Two D1 tables. KV `metadata.linear` is immutable.

```sql
linear_authored_comments (
  comment_id      TEXT PRIMARY KEY,   -- Linear comment id (UUID)
  oma_session_id  TEXT NOT NULL,      -- which bot session authored it
  issue_id        TEXT NOT NULL,      -- Linear issue UUID (must be UUID, not identifier)
  created_at      INTEGER NOT NULL
);
```

Reverse index: "Linear comment id → which bot session it belongs to". Webhook router uses this to route thread replies back to the right OMA session.

```sql
linear_issue_sessions (
  publication_id  TEXT,
  issue_id        TEXT,                -- Linear issue UUID
  session_id      TEXT,                -- OMA session id
  status          TEXT,                -- active | inactive
  created_at      INTEGER,
  PRIMARY KEY (publication_id, issue_id)
);
```

Per-issue OMA session reuse (so multiple AgentSessionEvents on the same issue resume the same bot session instead of creating a new one).

KV `metadata.linear`:
```json
{
  "publicationId": "...",   // which OAuth app
  "mcp_token": "...",       // per-session UUID for MCP auth
  "mcp_url": "...",         // hosted MCP endpoint
  "issueId": "..."          // bound issue UUID
}
```

All immutable per session. No fields are mutated mid-conversation.

---

## OAuth lifecycle

Linear's `actor=app` authorization-code flow returns a 24-hour `access_token` plus a `refresh_token`. Both are AES-GCM encrypted in `linear_installations`.

`LinearProvider.refreshAccessToken(installationId)` runs the OAuth refresh on demand (called by tool handlers when Linear returns `AUTHENTICATION_ERROR`). The new tokens are persisted, the vault bearer is rotated for the sandbox MITM injection layer, and the failing call is retried once.

Existing installs created before the refresh path landed have no stored `refresh_token`. For those, an admin endpoint (`/admin/linear-reauth-link`) generates a Linear consent URL that, on user approval, runs the OAuth dance and updates the tokens in place.

---

## Common patterns

### Bot delegated to an issue (panel mode)

```
1. webhook AgentSessionEvent.created (panel=ag_X)
2. provider creates/resumes per_issue OMA session, dispatches user.message
3. bot reads context, optionally calls linear_get_issue for more
4. bot calls linear_say(thought) to narrate progress (optional)
5. bot calls linear_say(response) with final answer → panel goes complete
```

### Bot pulls in another human (thread mode)

```
1. bot is in panel ag_X (per Case A)
2. bot calls linear_post_comment(body="@bob can you confirm?", issueId=...)
3. (panel UX continues independently)
4. bob replies in the thread without @-mentioning the bot
5. webhook Comment.create with parentId in linear_authored_comments
6. provider commentReply path dispatches user.message describing the reply
7. bot wakes off-panel, calls linear_post_comment(parentId=anchor) to respond
8. multi-turn continues; bot is responsible for each visible reply
```

### Bot needs a structured answer (elicitation)

```
1. bot in panel ag_X
2. bot calls linear_say(kind=elicitation, body="staging or prod?", panelId=ag_X)
3. panel UI flips to awaitingInput, inline reply box renders for delegator
4. bot stops (no more activity in this turn)
5. delegator replies in panel
6. webhook AgentSessionEvent.prompted → user.message
7. bot processes reply, continues work
```

---

## Linear-side limitations

| Limitation | Workaround |
|---|---|
| API-posted `@<bot>` text doesn't trigger `AgentSessionEvent` (only Linear UI editor does) | `agentSessionCreateOnIssue` mutation can spawn a panel server-side |
| API-posted comments need `bodyData` ProseMirror JSON to render mention chips (not just plain markdown body) | We rely on bot-posted plain `@<displayname>` which Linear server-side parses for chip + notification (works for human targets) |
| Once a panel emits `response`, it's `complete` — further activities accepted by API but UI doesn't render | Don't emit `response` until truly done; if more conversation is expected, use `thought` |
| Linear thread structure is flat (2 levels) — every reply parents to the root | Treat thread anchor (root) as the conversation key; all bot replies parent to it |
| Panel response activities are also rendered as comments inline in the issue thread | Bot's panel `say` is publicly visible to all subscribers — treat panel like comments for sensitivity |

---

## Future work (not in this iteration)

### Steer vs non-steer events

Currently every webhook that touches a bot-managed issue/comment fires a `user.message` and consumes an LLM turn. Bot has to respond (or explicitly stay silent) for every event.

A more economical model splits events into two channels:
- **Steer** — explicit calls to action (delegate, panel reply, thread reply on bot's authored). Wakes bot, expects response.
- **Non-steer** — ambient observations (other comments on subscribed issues, status changes, label tweaks). Bot sees them in context but doesn't necessarily respond.

Implementation requires SessionDO support for "notification events that don't trigger an LLM turn" — out of scope for this iteration.

### Subscribe to whole issue

Today the bot only sees:
- AgentSessionEvent webhooks (Linear's native panel triggers)
- Comment.create where parent is in `linear_authored_comments` (replies to bot's threads)

It does NOT see:
- Other comments on issues it's been delegated to
- Issue field changes (status / labels / title / description edits) on those issues

Adding this requires the steer/non-steer split above (otherwise the bot drowns in chatter).

---

## Files

| File | Purpose |
|---|---|
| `apps/integrations/src/routes/linear/mcp.ts` | MCP server: tool registry + JSON-RPC handlers |
| `apps/integrations/src/routes/linear/webhook.ts` | webhook receiver, signature verification |
| `apps/integrations/src/routes/linear/dedicated-callback.ts` | OAuth callback (install + reauth) |
| `packages/linear/src/provider.ts` | webhook parsing, dispatch, OAuth refresh |
| `packages/linear/src/webhook/parse.ts` | webhook envelope normalization |
| `apps/main/migrations/0008_linear_authored_comments.sql` | D1 schema |

Removed in this iteration:
- `apps/integrations/src/routes/linear/event-tap.ts` (auto-mirror — gone)
- `apps/main/migrations/0009_linear_oma_panel_binding.sql` (panel binding D1 table — gone)
- `linear_enter_panel` / `linear_exit_panel` MCP tools (no implicit binding — bot passes panelId per call)
- `metadata.linear.{currentAgentSessionId,triggerCommentId,lastElicitationAt,actor}` (mutating fields — gone)

---

## End-to-end test coverage

| Case | Issue | Outcome |
|---|---|---|
| Basic delegate + linear_say lifecycle | OPE-36 | ✅ |
| Bot post_comment + 3-round plain thread reply | OPE-38 | ✅ |
| Elicitation via linear_say(kind=elicitation) | OPE-37 | ✅ panel `awaitingInput` |
| linear_get_issue tool returns issue + thread context | OPE-41 | ✅ |
| Elicitation→response state machine (no save) | OPE-42 | ✅ panel goes `complete` |
| Bot self-loop prevention (`actor=bot` filter) | OPE-38 | ✅ webhook drops via `comment_reply_from_bot_self` |
| Unrelated top-level comment doesn't wake bot | OPE-40 | ✅ `ignored_event_Comment` |

`@bot` via Linear UI editor (Case 3) — verified manually only; no API path.
