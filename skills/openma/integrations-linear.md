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

## When to stop and ask the human

You can drive every step from the CLI **except** these two — they require a
human in front of a Linear browser tab:

1. **Pasting App values into Linear's OAuth App form** (step 1 → step 2 hand-off)
2. **Approving the OAuth install** (the install-URL click in step 2)

Don't try to automate the OAuth approval — Linear gates it on workspace admin
identity for good reason. Hand off cleanly and wait.

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
