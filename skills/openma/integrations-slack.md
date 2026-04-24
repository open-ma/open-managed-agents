---
name: openma-integrations-slack
description: >
  Bind an openma agent to a Slack workspace as a real teammate (mentionable
  via @<bot>, replies in threads, joins DMs, hosts AI assistant threads).
  Use when the user asks to "bind to Slack", "publish to Slack", "make this
  agent a Slack bot", "let my agent answer in Slack", "let my agent triage
  channel messages", or anything that ends with "Slack" + "agent". Uses
  Slack's "Create from manifest" URL flow so most setup is one click;
  covers what to do when the human is needed and how the agent acts back
  via both `mcp.slack.com` (typed tools) and `slack.com/api` (chat).
---

# Bind an openma agent to Slack

Make an openma agent appear in a Slack workspace under its own bot identity —
mentionable in channels, repliable in threads, hostable in the AI assistant
pane. Ships in `oma slack …`.

## Prerequisites

- `OMA_BASE_URL` and `OMA_API_KEY` set (see the `openma` skill for setup).
- API key minted from a logged-in Console session, **not** the static
  `API_KEY` env var. Slack endpoints are user-scoped: legacy keys without
  `user_id` get `403 user-scoped endpoint: regenerate your API key`.
- The agent already exists (`oma agents list` to confirm).
- An environment exists (`oma envs list`).
- Slack workspace **admin** access (only admins can install Slack Apps).

## Architecture in one paragraph

Each agent gets its **own Slack App** (per-agent identity, not a shared bot).
The App registration goes through Slack's **"Create from manifest" URL
flow**: openma generates a manifest JSON pre-filled with name, scopes,
events, and the Events Request / Redirect URLs; the user opens one link,
clicks Create, and Slack provisions the App. After install, openma stores
**two vaults bound to two MCP origins**: a `xoxp-` user token vault for
`mcp.slack.com/mcp` (typed tools — search, history, canvases) and a `xoxb-`
bot token vault for `slack.com/api` (chat.postMessage, reactions,
conversations.replies, etc.). One install, two surfaces, one bot identity,
one audit trail. xoxb / xoxp tokens are long-lived by default — no
auto-refresh needed unless the workspace explicitly enables Token Rotation.

## Walk-through

### Step 1 — start the bind

```bash
oma slack publish <agent-id> --env <env-id> [--persona "Triage"] [--avatar https://…]
```

The CLI prints a **manifest launch URL**:

```
→ One-click setup — open this URL to have Slack create the App for you:

   https://api.slack.com/apps?new_app=1&manifest_json=…

Slack will pre-fill name, scopes, events, and redirect URL from a manifest.
Confirm Create on Slack, then come back and paste the secrets it shows you.
```

Hand that URL to the human. When they open it:

1. Slack shows a **manifest editor** pre-populated with all our fields
   (App name = persona, bot scopes, user scopes, event subscriptions URL,
   bot events, redirect URL).
2. They click **Create** at the bottom of the manifest editor.
3. Slack creates the App and lands them on its **Basic Information** page.
4. They copy three values from that page: **Client ID**, **Client Secret**,
   **Signing Secret**.

> **HTTPS / public-host caveat.** Manifest URLs come from `GATEWAY_ORIGIN`
> on the integrations worker, not from `OMA_BASE_URL`. Slack requires HTTPS
> on a publicly-reachable host for the Events Request URL and OAuth Redirect
> URL — it tries to verify both. If `publish` warns about a non-HTTPS or
> localhost URL, you're double-blocked: Slack rejects, and even if it didn't
> couldn't reach localhost. Fix: deploy the integrations worker, or run a
> tunnel (`cloudflared`/`ngrok`) and set `GATEWAY_ORIGIN` accordingly.

### Step 2 — submit credentials

```bash
oma slack submit <FORM_TOKEN> \
  --client-id <CLIENT_ID> \
  --client-secret <CLIENT_SECRET> \
  --signing-secret <SIGNING_SECRET>
```

CLI prints a Slack OAuth URL. Open in browser → authorize → land back at
openma. The publication transitions to `live`.

### Step 3 — verify

```bash
oma slack list                          # shows the workspace + bot user id
oma slack pubs <installation-id>        # shows the agent with status=live
oma slack get <publication-id>          # shows persona, capabilities, agent_id
```

### Step 4 — test it from inside Slack

Invite the bot to a channel (`/invite @<bot>`), then `@`-mention it. Or DM
it directly. Or open the AI assistant pane and start a thread with it.
The agent should respond as a Slack message within seconds. Watch live
state with `oma sessions list` — a fresh session appears for each thread
(default `session_granularity: "per_thread"`), keyed on
`<channel_id>:<thread_ts>`.

## Manual fallback (for users who can't use manifest flow)

If the user wants to register the App by hand (audit-conscious orgs,
custom scopes), the same `oma slack publish` output also lists:

- The **App name** to set
- The **Redirect URL** to paste under OAuth & Permissions
- The **Events Request URL** to paste under Event Subscriptions
- The exact **bot events** to subscribe to

They register the App at `https://api.slack.com/apps` → Create New App
→ From scratch, configure those four things, then run `oma slack submit`
with the credentials they get from Basic Information. Same outcome as
manifest flow, more clicks.

## Handoff to a workspace admin

If the publisher isn't a Slack admin themselves:

```bash
oma slack handoff <FORM_TOKEN>
```

Returns a 7-day shareable URL. Send it to the workspace admin. They open
it (no openma login required), see the same manifest one-click button + a
form for the 3 secrets, and complete the install. The token IS the auth —
treat the URL as sensitive.

## What the agent receives when Slack triggers it

Default event matrix — the agent wakes up on signals **directly addressed
to the bot** OR explicit AI-assistant-thread starts:

| Slack event | Condition | OMA event |
|---|---|---|
| `app_mention` | message contains `<@bot_user_id>` | `app_mention` |
| `message.channels` / `message.groups` / `message.im` / `message.mpim` | message in a thread where the bot has an active session | `message_in_thread` |
| `assistant_thread_started` | user opened a new AI assistant thread with the bot | `assistant_thread_started` |
| `tokens_revoked` / `app_uninstalled` | workspace admin removed the App | (no session — install marked revoked) |

NOT in the default matrix: top-level `message.*` events without an active
thread session, message edits, reactions, channel joins, file uploads.
These can be opted into via future `--mode {triage, watch, …}` flags but
are silent in v1.

A self-wakeup guard drops every event from the bot itself (detected via
`message.subtype === "bot_message"` AND `bot_id` matching the install's
bot user). Without this, the bot's own reply would re-trigger the
`message.channels` subscription.

The agent's first user message looks like:

```
Slack app_mention in #engineering (thread 1700000000.000100)
From: @alice
Body: <@U07BOT> can you take a look at the deploy failure?
```

For threaded replies the prior thread context is NOT pre-loaded — the
agent fetches it via `mcp__slack__conversations_replies` (Surface 1 below).

## How the agent acts back: two surfaces, one install

Both surfaces are wired automatically by `bind`. The agent picks based on
what it's doing:

### Surface 1: Slack hosted MCP (typed tools, for search / history / canvases)

The user `xoxp-` token is bound to `https://mcp.slack.com/mcp`. Slack
operates this as a hosted MCP server; outbound requests carry the user's
permissions (search, channel access, canvases). Agent calls typed MCP tools
registered as `mcp__slack__*`:

- `mcp__slack__search_messages(query, …)`
- `mcp__slack__conversations_history(channel, oldest?, limit?)`
- `mcp__slack__conversations_replies(channel, ts)` — fetch a full thread
- `mcp__slack__canvases_create(channel, title, content)`
- `mcp__slack__users_lookup_by_email(email)`

The xoxp token inherits the installing user's permissions, so anything they
can see, the agent can see.

### Surface 2: Slack Web API (for chat, reactions, file ops)

The bot `xoxb-` token is bound to `https://slack.com/api`. Outbound proxy
attaches it as `Authorization: Bearer xoxb-…` on any HTTPS call to that
origin. Agent uses the standard `bash` tool with `curl`:

```bash
# Reply in the same thread
curl -X POST https://slack.com/api/chat.postMessage \
  -H "content-type: application/json; charset=utf-8" \
  -d '{"channel":"C123","thread_ts":"1700000000.000100","text":"On it."}'

# Add a reaction
curl -X POST https://slack.com/api/reactions.add \
  -H "content-type: application/json; charset=utf-8" \
  -d '{"channel":"C123","timestamp":"1700000000.000100","name":"eyes"}'

# Upload a file
curl -X POST https://slack.com/api/files.upload_v2 -F …
```

The bot can do anything the bot scopes allow (chat:write, reactions:write,
etc.).

## Token lifecycle

Slack `xoxb-` (bot) and `xoxp-` (user) tokens are **long-lived by default**
— they don't expire unless the workspace admin explicitly enables Token
Rotation in the App's settings. openma stores them as-is and doesn't
auto-refresh. If the workspace turns Rotation on, the App will start
issuing 12-hour tokens with refresh tokens; openma's current dedicated
flow doesn't yet rotate these (the schema is intentionally narrowed —
no `refresh_token_cipher` column). To recover from a rotation event,
unpublish + re-bind. Tracked as future work.

## Common things to do after bind

| Goal | Command |
|---|---|
| Tighten what the agent can do | `oma slack update <pub-id> --caps message.read,message.write,thread.reply,reaction.add,…` |
| Allow the agent to write canvases | `oma slack update <pub-id> --caps …,canvas.write` |
| Rename the persona | `oma slack update <pub-id> --persona "NewName"` |
| Change avatar | `oma slack update <pub-id> --avatar https://…` |
| Stop the agent | `oma slack unpublish <publication-id>` |

> **Note on capability semantics.** OMA-side capability keys are advisory —
> the actual gates are Slack OAuth scopes (set in the manifest at
> registration time). `canvas.write` in OMA caps is a hint; if the App
> wasn't granted `canvases:write` Slack rejects regardless. Changing
> manifest scopes after install requires re-installing the App (Slack
> doesn't allow live scope upgrades).

## When you reach a human-required step

Two steps physically need a human in a browser:

1. **Manifest confirm** — clicking "Create" on the manifest editor at
   api.slack.com (the App is created under whoever's logged in).
2. **OAuth install approval** — clicking "Allow" on the OAuth grant page
   in the workspace (workspace admin only).

You're acting as the user's agent. **Offer to drive the browser, then take
direction:**

> I'm at the step where the Slack App needs to be created. Two options:
>
> **a) I can drive your browser for you.** I see a Slack tab open at
>    api.slack.com. I'd open the manifest URL, click Create, then click
>    Allow on the OAuth page. Takes ~45 seconds.
>
> **b) Or you do it yourself.** I'll print the manifest URL; you open
>    it, click Create, copy 3 secrets, paste them, click Install. Same
>    ~45 seconds.

Browser detection (in rough order of capability):

| Capability | How to detect |
|---|---|
| Browser-automation MCP / SDK | `browser_*`, `playwright_*`, `puppeteer_*` in tool list |
| Browser CLI on PATH | `which agent-browser` or whatever the harness ships |
| Chrome DevTools Protocol | `curl -s http://localhost:9222/json/list \| grep slack.com` |
| `WebFetch` only | last resort — doesn't work for the OAuth click (needs session cookies) |

If you don't have any browser tools, skip to (b) directly — but say so.

## Troubleshooting

### Slack's "Verify" check fails on the Events Request URL

Slack POSTs a `url_verification` envelope to that URL within seconds of
saving. The integrations gateway must:

1. Be reachable on a public HTTPS host (no localhost / self-signed certs).
2. Have the App row in `slack_apps` (so the signing secret can be looked
   up to verify the handshake).
3. Respond within ~3 seconds with the echoed `challenge` string.

If `Verify` keeps failing: tail the gateway and look for the inbound POST.
Common causes are listed below.

### Webhook arriving but nothing happens

Check `oma sessions list` for a new session. If none, look at gateway logs:

```bash
wrangler tail -c apps/integrations/wrangler.jsonc | grep slack-webhook
```

| `reason=` | Cause |
|---|---|
| `missing_app_id` | Webhook URL points at a stale `appOmaId`. Re-bind. |
| `unknown_app_id` | App row was deleted. Re-bind. |
| `invalid_signature_header` | Slack didn't include `X-Slack-Signature`, or it's malformed. Suggests the request didn't actually come from Slack. |
| `invalid_signature` | Stored signing secret doesn't match the App's actual secret. With manifest flow this can't happen unless the App's secret was rotated externally; with manual `submit`, double-check `--signing-secret`. |
| `stale_timestamp` | Request older than 5 min. Either replay attack OR server clock skew >5 min — check NTP. |
| `duplicate_event` | Idempotency: Slack retried (it does this aggressively if our 200 isn't fast enough). Already handled. |
| `ignored_event_kind` | Not in default matrix (e.g. message edit, reaction, top-level channel message without an active thread session). |
| `bot_self_message` | The bot's own message would have re-triggered itself. Self-wakeup guard fired. |

### Bot stops responding mid-session

Most likely the workspace admin uninstalled the App, or revoked OAuth
scopes. `oma slack get <pub-id>` will show `status: needs_reauth` if
openma detected revocation (via `tokens_revoked` / `app_uninstalled`
events). Re-bind to recover.

If `status` still shows `live` but the agent is silent: the bot may not be
in the channel. Slack only delivers `message.channels` events in channels
the bot has been invited to (`/invite @<bot>`). `app_mention` events fire
in any channel the @-mention reaches the bot, but reading prior thread
context requires `conversations.history`, which needs membership.

### Bot replying to itself

This shouldn't happen — the parser drops every event where
`subtype === "bot_message"` and `bot_id` matches the install. If you see
infinite replies, file a bug with the Slack `event_id`.

## Comparison to Linear & GitHub

|  | Linear | GitHub | Slack |
|---|---|---|---|
| Bot identity | OAuth App (`actor=app`) | GitHub App (`<slug>[bot]`) | Slack App (bot user `U…`) |
| Registration | Manual form-fill (5 min) | Manifest flow (one click, ~30s) | Manifest URL (one click + paste 3 secrets, ~1 min) |
| Webhook secret | Linear auto-generates (`lin_wh_…`) | Manifest auto-generates (server-side) | Slack signing secret (per-App, manual copy from Basic Information) |
| Auth on writes | Long-lived OAuth bearer | 1-hour installation token + auto refresh | Long-lived `xoxb-` (bot) + `xoxp-` (user) |
| Write surfaces | MCP only | MCP (issues/PRs) + sandbox `gh`/`git` (code) | MCP (`mcp.slack.com` for search/history) + Web API (`slack.com/api` for chat/reactions) |
| Mention syntax | `@<persona-name>` | `@<slug>[bot]` | `@<bot-display-name>` |
| Per-agent setup | One Linear OAuth App | One GitHub App | One Slack App |
| Admin required | Linear workspace admin | GitHub org owner | Slack workspace admin |
| Webhook timeout | ~10 sec | ~10 sec | **3 sec** — provider returns deferred work for the route to `waitUntil` |
| Replay window | n/a (single signing secret) | n/a (delivery id idempotency only) | 5 min via `X-Slack-Request-Timestamp` |
