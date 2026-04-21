---
name: openma-integrations-linear
description: >
  Publish an openma agent into a Linear workspace as a real teammate (assignable
  in the dropdown, mentionable via @, replies to comments). Use when the user
  asks to "publish to Linear", "make this agent a Linear bot", "assign Linear
  issues to my agent", or anything that ends with "Linear" + "agent". Walks
  through the OAuth-app handshake step by step, with concrete CLI commands and
  the one moment a human is genuinely needed.
---

# Publish an openma agent to Linear

Make an openma agent appear in a Linear workspace under its own identity —
assignable, mentionable, posting comments back. Ships in `oma linear …`.

## Prerequisites

- `OMA_BASE_URL` and `OMA_API_KEY` set (see the `openma` skill for setup).
- The API key was minted from a logged-in Console session, **not** from the
  static `API_KEY` env var. Linear endpoints are user-scoped: legacy keys
  without `user_id` get `403 user-scoped endpoint: regenerate your API key`.
  If you hit that, ask the human to mint a fresh key from the Console.
- The agent already exists (`oma agents list` to confirm).
- An environment exists (`oma envs list`).

## Architecture in one paragraph

Each agent gets its own Linear OAuth App (per-agent identity, not a shared
bot). The publish flow is three steps: (1) openma mints a `formToken` and
shows you the App-config values to paste into Linear; (2) you (or the human
admin) register the App in Linear and paste the `clientId`/`clientSecret`
back; (3) Linear's OAuth flow redirects to the openma callback, which links
the App to a `publication` row and creates a vault credential the agent uses
for outbound writes.

## Walk-through

### Step 1 — start the publish flow

```bash
oma linear publish <agent-id> --env <env-id> [--persona "Coder"] [--avatar https://…]
```

The CLI prints **App name / Callback URL / Webhook URL** plus a `formToken`.
Hand the three App values to the human (or to a Linear admin) along with this
exact instruction:

> Open Linear → Settings → API → "New OAuth Application", paste these three
> values, **enable Webhooks** and paste the Webhook URL there too, then send
> me back the **Client ID**, **Client Secret**, and **Webhook signing secret**
> (the `lin_wh_…` value Linear shows you on its Webhooks panel).

The Callback / Webhook URLs are real (not `<APP_ID>` placeholders) — the
human must paste them verbatim. Re-running `publish` mints a *new* `formToken`
with a *new* appId, so don't re-run between steps unless you mean to.

> **Why three secrets, not two.** Linear's "New OAuth application" form has
> a "Webhook signing secret" field that looks editable but is actually
> auto-generated server-side: anything pasted in is silently overwritten with
> Linear's own `lin_wh_…` value. OMA used to predict its own and the verifier
> would fail every webhook silently (HTTP 200 + `invalid_signature` body,
> Linear sees 2xx and never reports a delivery failure → no Linear UI signal,
> no D1 row, no session). Fix: the user copies Linear's actual secret back
> into `oma linear submit`, OMA stores that, verifier passes.

> **URL host caveat.** The Callback / Webhook URLs come from the integrations
> gateway's `PUBLIC_BASE_URL`, **not** from your client's `OMA_BASE_URL`.
> Linear's "New OAuth application" form has client-side validation that
> **rejects `http://` URLs outright at submit time** — even publicly-reachable
> ones. You need an HTTPS origin for both URLs. So if `publish` returns
> `http://localhost:8787/...` you're double-blocked: Linear's form won't save
> it, and even if it did, Linear couldn't reach localhost. To proceed: deploy
> the integrations worker, or run a tunnel (`cloudflared`/`ngrok`) and set
> `GATEWAY_ORIGIN` on the integrations worker to that public HTTPS host
> before retrying `oma linear publish`.

For machine-readable output add `--json` — it skips the prose and prints the
raw `{ formToken, callbackUrl, webhookUrl, suggestedAppName }`.

### Step 2 — submit the credentials Linear gave back

```bash
oma linear submit <form-token> \
  --client-id <id> \
  --client-secret <secret> \
  --webhook-secret <lin_wh_…>      # the Linear-generated one, NOT something you made up
```

Returns a Linear OAuth install URL. Hand that URL to a human with **Linear
admin rights on the workspace** — only an admin can authorize the install.
After approval Linear redirects to the openma callback and the publication
goes from `pending_setup` → `live`.

If the human who has the `clientId`/`clientSecret`/`webhookSecret` is *not*
the admin (common in larger orgs), use `oma linear handoff <form-token>`
instead — that returns a 7-day shareable URL the admin can complete on their
own (the handoff form prompts for all three secrets too).

### Step 3 — verify

```bash
oma linear list                          # shows the workspace
oma linear pubs <installation-id>        # shows the agent with status=live
oma linear get <publication-id>          # shows persona, capabilities, agent_id
```

If `status` is stuck at `pending_setup` or `awaiting_install`, the OAuth step
hasn't been approved yet. If it's `needs_reauth`, the install was revoked in
Linear and the human must re-approve.

### Then test it from inside Linear

Ask the human to assign a real Linear issue to the persona (or `@mention` it
in a comment). The agent should respond as a Linear comment within seconds.
Watch the live state with `oma sessions list` — a fresh session appears for
each issue (default `session_granularity: "per_issue"`).

## Common things to do after publish

| Goal | Command |
|---|---|
| Tighten what the agent can do in Linear | `oma linear update <pub-id> --caps issue.read,comment.write,…` |
| Rename the persona | `oma linear update <pub-id> --persona "NewName"` |
| Change avatar | `oma linear update <pub-id> --avatar https://… ` (empty string clears) |
| Stop the agent from responding | `oma linear unpublish <publication-id>` |
| Re-publish after unpublish | start over with `oma linear publish` (a new App is minted; the old one in Linear can be deleted) |

## When you reach a human-required step

Two steps in this flow physically require a Linear browser session:

1. **Step 1 → Step 2 hand-off**: pasting App values into Linear's "New OAuth
   Application" form and copying the resulting Client ID / Secret back.
2. **Step 2 → Step 3 hand-off**: clicking the OAuth install URL and approving
   the install (Linear gates this on workspace admin identity).

You're acting as the user's agent. Don't just hand off and wait — **offer
to help**, then take direction. The protocol is:

### a. Check what browser tools you have

Look for whatever browser-driving capability your environment provides.
Common shapes (in rough order of capability):

| Capability shape | How to detect |
|---|---|
| A general browser-automation MCP / SDK | check the tool list for anything matching `browser_*`, `playwright_*`, `puppeteer_*`, etc. |
| A browser-automation CLI on PATH | `which <name>` for whatever the user's harness ships |
| Chrome DevTools Protocol on a known port | `curl -s http://localhost:9222/json/list` (also try 9333, 9223 — varies by setup) |
| `WebFetch` / HTTP only | last resort — works for read-only scraping, not for OAuth flows that need session cookies |

If the user already has a Chrome / browser session open and logged into
Linear (check `curl -s http://localhost:9222/json/list | grep linear.app`),
that's the highest-leverage path: their session works as-is, no auth dance.
Don't assume a specific tool — use whatever you actually have, and tell
the user what you're using.

### b. Ask the user

Phrase it as a real choice, surface what you can offer:

> I'm at the step where Linear's OAuth App needs to be created. Two options:
>
> **a) I can drive your browser for you.** I see you have a Linear tab
>    open at `linear.app/<workspace>/settings/api`; I'd open the "New OAuth
>    Application" form and paste these four values, then read the Client ID
>    and Secret back to continue. Takes ~30 seconds.
>
> **b) Or you do it yourself.** I'll print the four values and the exact
>    URL; you paste, then send me back the Client ID and Secret.

If you don't have any browser tools, skip to (b) directly — but say so:
"I don't have browser automation here, so you'll need to do this yourself."

### c. If the user picks "drive it"

Drive the existing logged-in browser tab. Don't navigate away from any tab
the user has work in; open a new one if needed. After you've pasted the
four values, scrape the Client ID, Client Secret, and Webhook signing secret
from Linear's response page and feed them straight into `oma linear submit`.

For the **install approval** (step 2 → 3), same pattern: open the install
URL in the user's logged-in tab, click "Authorize". Confirm with
`oma linear list && oma linear pubs <installation-id>` — status should
read `live`.

> **The painful step has a one-shot script.** `scripts/linear-oauth-app-create.sh`
> in this repo creates the Linear OAuth App via Linear's GraphQL `OauthClientCreate`
> mutation (no form-driving), borrowing auth from a logged-in browser tab over
> CDP. Returns `{appId, clientId, clientSecret, webhookSecret, webhookUrl}` as
> JSON. Usage:
>
> ```bash
> scripts/linear-oauth-app-create.sh \
>   --workspace boai \
>   --name MyBot \
>   --callback-url https://gateway/linear/oauth/app/<APP_ID>/callback \
>   --webhook-url  https://gateway/linear/webhook/app/<APP_ID> \
>   | jq
> ```
>
> The output is shaped exactly to feed `oma linear submit`'s flags. Use this
> instead of driving the React form — Linear's webhook section renders
> asynchronously and `agent-browser fill` against React-controlled inputs
> needs the prototype-setter+dispatchEvent dance to actually stick.

> **Multi-tab Chrome gotcha.** Some browser tools cache a target reference
> and drift between tabs when the attached Chrome has more than one page
> open. agent-browser added `tab N` (1-indexed via `tab list`) which works
> reliably; older "auto-pick most-recent" heuristics drift. If your tool
> doesn't have `tab` switching, the escape hatch is to drive CDP directly:
> bind to that specific tab's `webSocketDebuggerUrl` (from
> `curl http://localhost:<cdp-port>/json/list`) over a single WebSocket,
> and the connection stays bound for its lifetime.

### d. If the user picks "manual"

Print exactly this, with values substituted:

```
Open: https://linear.app/<workspace-slug>/settings/api
Click: "New OAuth Application"
Fill:
  Application name:  <suggestedAppName>
  Callback URL:      <callbackUrl>
Enable Webhooks, then fill:
  Webhook URL:       <webhookUrl>
  Webhook events:    Comments, Issues, Agent session events
Click Create.

Linear will show you a Client ID and Client Secret on the resulting page,
and a Webhook signing secret (starts with `lin_wh_`) under the Webhooks
panel. Reply with all three and I'll continue.
```

When they reply, run
`oma linear submit <form-token> --client-id … --client-secret … --webhook-secret lin_wh_…`
and hand them the install URL with the same a/b choice.

### Why we don't just always automate

- The user might not want their browser touched mid-task.
- Form-fill and OAuth approval against Linear's UI is brittle to copy
  changes; a human paste is more reliable for one-shot flows.
- The user's browser holds their actual workspace identity. Driving it
  without consent is bad form even when technically possible.

## Failure modes

- `403 user-scoped endpoint: regenerate your API key` — your API key is from
  before user_id was tracked, or it's the static `API_KEY` env var. Ask the
  human to mint a fresh key from Console → API Keys.
- `INTEGRATIONS binding missing` — the deployment is missing the integrations
  service binding. This is an ops issue; tell the human to deploy
  `apps/integrations`.
- **Webhooks silently dropped** (publication shows `live`, no sessions
  appear, Linear's "Webhook delivery failures" panel says "no failures") —
  the wrong `webhookSecret` was stored. Either an old `oma linear submit`
  was used without `--webhook-secret`, or the user pasted a different value
  than the `lin_wh_…` Linear actually generated. Verify with the gateway's
  tail logs:

  ```bash
  pnpm exec wrangler tail managed-agents-integrations[-staging] | grep linear-webhook
  ```

  A `reason=invalid_signature` line on a real Linear delivery means the
  D1-stored secret doesn't match Linear's. Fix: tear down the publication
  (`oma linear unpublish <pub>`), re-run the publish flow, and pass the
  `lin_wh_…` value Linear shows (right side of the OAuth app's Webhooks
  panel) to `oma linear submit --webhook-secret`.
- `MCP_SIGNING_KEY` rotation breaks already-stored secrets — they were
  encrypted with the old key and won't decrypt. Re-run the publish flow.
- A delivery shows `reason=installation_not_found_or_revoked` after the
  install was approved — the App row's `publication_id` is null because
  the OAuth callback didn't complete. Re-trigger the install.

## Where the API lives

The Console UI in `packages/integrations-ui/` is the same flow with a
graphical wizard. The HTTP routes are in
`apps/main/src/routes/integrations.ts` and proxy to `apps/integrations/`
(which holds the OAuth state JWTs and webhook signing). Provider logic is in
`packages/linear/`.
