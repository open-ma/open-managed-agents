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

The CLI prints **App name / Callback URL / Webhook URL / Webhook secret** plus
a `formToken`. Hand the four App values to the human (or to a Linear admin)
along with this exact instruction:

> Open Linear → Settings → API → "New OAuth Application", paste these four
> values, then send me back the **Client ID** and **Client Secret** Linear
> shows you on the resulting page.

The Callback / Webhook URLs are real (not `<APP_ID>` placeholders) — the
human must paste them verbatim. Re-running `publish` mints a *new* `formToken`
with a *new* appId, so don't re-run between steps unless you mean to.

> **URL host caveat.** The Callback / Webhook URLs come from the integrations
> gateway's `PUBLIC_BASE_URL`, **not** from your client's `OMA_BASE_URL`. If
> they point at `localhost` you can't paste them into a real Linear App —
> Linear can't reach your laptop. The CLI prints a warning when it detects
> this. To proceed, either deploy the integrations worker to a public host,
> or run a tunnel (`cloudflared`/`ngrok`) and set `PUBLIC_BASE_URL` to the
> tunnel hostname before retrying.

For machine-readable output add `--json` — it skips the prose and prints the
raw `{ formToken, callbackUrl, webhookUrl, webhookSecret, suggestedAppName }`.

### Step 2 — submit the credentials Linear gave back

```bash
oma linear submit <form-token> --client-id <id> --client-secret <secret>
```

Returns a Linear OAuth install URL. Hand that URL to a human with **Linear
admin rights on the workspace** — only an admin can authorize the install.
After approval Linear redirects to the openma callback and the publication
goes from `pending_setup` → `live`.

If the human who has the `clientId`/`clientSecret` is *not* the admin (common
in larger orgs), use `oma linear handoff <form-token>` instead — that returns
a 7-day shareable URL the admin can complete on their own.

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

Look for any of these in your environment (rough order of capability):

| Tool | How to detect |
|---|---|
| `agent-browser` (CLI) | `which agent-browser` |
| Playwright MCP server | available tool starting with `mcp_playwright_` or similar |
| `browser-use` / `browser_use_*` MCP | similar |
| Chrome DevTools Protocol on a known port | `curl -s http://localhost:9222/json/list` (or :9333) |
| WebFetch + form submission | last resort, doesn't handle session cookies well |

If the user already has a Chrome / browser session open and logged into
Linear (check `curl -s http://localhost:9222/json/list | grep linear.app`),
that's the highest-leverage path: their session works as-is, no auth dance.

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
four values, scrape the Client ID and Client Secret from Linear's response
page and feed them straight into `oma linear submit`.

For the **install approval** (step 2 → 3), same pattern: open the install
URL in the user's logged-in tab, click "Authorize". Confirm with
`oma linear list && oma linear pubs <installation-id>` — status should
read `live`.

### d. If the user picks "manual"

Print exactly this, with values substituted:

```
Open: https://linear.app/<workspace-slug>/settings/api
Click: "New OAuth Application"
Fill:
  Application name:  <suggestedAppName>
  Callback URL:      <callbackUrl>
  Webhook URL:       <webhookUrl>
  Webhook secret:    <webhookSecret>
Click Create.

Linear will show you a Client ID and Client Secret. Reply with both and
I'll continue.
```

When they reply, run `oma linear submit <form-token> --client-id … --client-secret …`
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
- Webhook signature verification fails after install — the `MCP_SIGNING_KEY`
  changed between when the App was registered and now. The webhook secret
  shown to the user was encrypted with the old key. Re-run `oma linear publish`
  to mint a new App with a fresh secret.

## Where the API lives

The Console UI in `packages/integrations-ui/` is the same flow with a
graphical wizard. The HTTP routes are in
`apps/main/src/routes/integrations.ts` and proxy to `apps/integrations/`
(which holds the OAuth state JWTs and webhook signing). Provider logic is in
`packages/linear/`.
