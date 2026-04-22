---
name: openma-integrations-github
description: >
  Bind an openma agent to a GitHub org as a real teammate (assignable on
  issues/PRs, mentionable via @<bot>, request-as-reviewer, replies to comments).
  Use when the user asks to "bind to GitHub", "publish to GitHub", "make this
  agent a GitHub bot", "let my agent review PRs", "let my agent triage issues",
  or anything that ends with "GitHub" + "agent". Uses the GitHub App Manifest
  flow so registration is one click; covers what to do when the human is
  needed and how the agent acts back via both MCP and sandbox `gh`.
---

# Bind an openma agent to GitHub

Make an openma agent appear in a GitHub org under its own bot identity —
assignable on issues, request-as-reviewer on PRs, posting comments as itself.
Ships in `oma github …`.

## Prerequisites

- `OMA_BASE_URL` and `OMA_API_KEY` set (see the `openma` skill for setup).
- API key minted from a logged-in Console session, **not** the static
  `API_KEY` env var. GitHub endpoints are user-scoped: legacy keys without
  `user_id` get `403 user-scoped endpoint: regenerate your API key`.
- The agent already exists (`oma agents list` to confirm).
- An environment exists (`oma envs list`).

## Architecture in one paragraph

Each agent gets its **own GitHub App** (per-agent identity, not a shared bot).
The App registration goes through GitHub's **Manifest flow**: openma generates
a manifest JSON, the user clicks one button, GitHub fires up the App and
returns its credentials in a single round-trip — zero copy-paste of App IDs
or .pem files. After install, openma stores **one vault with two
credentials** holding the same installation token: a `static_bearer` for
the GitHub MCP server (typed tools for issues/PRs/comments) and a
`command_secret` that injects `GITHUB_TOKEN` into sandbox `gh` and `git`
calls (for repo cloning, file edits, PR creation). Both surfaces, one token,
one identity, one audit trail. The 1-hour installation token is refreshed
automatically (on every webhook dispatch, on every session create, and on
401 from outbound calls).

## Walk-through

### Step 1 — start the bind

```bash
oma github bind <agent-id> --env <env-id> [--persona "Coder"] [--avatar https://…]
```

The CLI prints a **manifest start URL**:

```
→ Open this URL to register the GitHub App in one click:

   https://<gateway>/github/manifest/start/<formToken>

After confirming on GitHub you'll bounce through to "Install on org" automatically.
```

Hand that URL to the human. When they open it:

1. Browser auto-POSTs the manifest to `github.com/settings/apps/new`.
2. GitHub renders **"Create GitHub App for <persona>"** — they click confirm.
3. GitHub redirects through the openma gateway's `/github/manifest/callback`
   which exchanges the manifest code, persists App credentials, and bounces
   them to **`https://github.com/apps/<slug>/installations/new`** for org
   selection.
4. They pick the org (or personal account) and click **Install**.
5. GitHub redirects back to openma; the publication transitions to `live`.

> **HTTPS / public-host caveat.** Manifest URLs come from `GATEWAY_ORIGIN`
> on the integrations worker, not from `OMA_BASE_URL`. GitHub requires HTTPS
> on a publicly-reachable host. If `bind` returns `http://localhost:8787/...`
> you're double-blocked: GitHub rejects, and even if it didn't, GitHub
> couldn't reach localhost. Fix: deploy the integrations worker, or run a
> tunnel (`cloudflared`/`ngrok`) and set `GATEWAY_ORIGIN` accordingly.

> **Org admin required for install.** Anyone can register an App; only an
> org owner can install one. If the user isn't the owner, they share the
> manifest start URL with whoever is. The flow works the same — register
> happens under the App's owner account, install happens under the org.

### Step 2 — verify

```bash
oma github list                          # shows the org + bot login
oma github pubs <installation-id>        # shows the agent with status=live
oma github get <publication-id>          # shows persona, capabilities, agent_id
```

### Step 3 — test it from inside GitHub

Ask a human to assign a real issue to the bot (or `@mention` it in a comment,
or request-as-reviewer on a PR). The agent should respond as a GitHub comment
within seconds. Watch live state with `oma sessions list` — a fresh session
appears for each issue/PR (default `session_granularity: "per_issue"`),
keyed on `<repo>#<number>`.

## Manual fallback (for users who can't use manifest flow)

For air-gapped environments or users who want full control over the App's
permissions before binding, `oma github bind` also prints a manual fallback
command:

```bash
oma github submit <form-token> \
  --app-id <numeric-id> \
  --private-key-file ~/Downloads/myapp.<appid>.private-key.pem \
  --webhook-secret <whatever-you-chose>
```

Use this when the user has registered the GitHub App by hand on
`github.com/settings/apps/new` (or via a script). They paste the App ID,
the .pem, and the webhook secret they chose. Same install URL is returned
as with manifest flow.

## What the agent receives when GitHub triggers it

Default event matrix — the agent wakes up ONLY on signals **directly addressed
to the bot**:

| GitHub event | Condition | OMA event |
|---|---|---|
| `issues.assigned` | assignee.login == bot | `issue_assigned` |
| `pull_request.assigned` | assignee.login == bot | `pr_assigned` |
| `pull_request.review_requested` | requested_reviewer == bot | `pr_review_requested` |
| `issue_comment.created` | body contains `@<bot>` | `issue_mentioned` / `pr_mentioned` |
| `pull_request_review_comment.created` | body contains `@<bot>` | `pr_mentioned` |
| `pull_request_review.submitted` | bot was the requested reviewer | `pr_review_submitted` |

NOT in the default matrix (intentionally — they're firehoses for "teammate"
mode): `issues.opened`, `pull_request.opened`, `workflow_run.failure`,
`check_run.failure`, plain `issue_comment` without mention. These can be
opted into via future `--mode {triage, reviewer, ci-watch}` flags but are
silent in v1.

A self-wakeup guard drops every event where `sender.login == bot.login`,
otherwise the bot's own comment would re-trigger itself indefinitely.

The agent's first user message looks like:

```
GitHub issue_assigned on acme/api#142
Title: Fix the auth bug
From: @alice
URL: https://github.com/acme/api/issues/142
```

For comment / review events the comment body is appended. Full issue body,
file diffs, and prior comments are NOT pre-loaded — the agent fetches them
via the dual surface (see next section).

## How the agent acts back: two surfaces, one token

Both surfaces are wired automatically by `bind`. The agent picks based on
what it's doing:

### Surface 1: GitHub MCP (typed tools, for issues / PRs / comments)

Vault has a `static_bearer` credential matching `api.githubcopilot.com`.
Agent calls typed MCP tools registered as `mcp__github__*`. Outbound proxy
attaches the installation token as `Authorization: Bearer ghs_…`. Examples:

- `mcp__github__create_issue_comment(repo, number, body)`
- `mcp__github__add_labels(repo, number, labels)`
- `mcp__github__create_pr_review(repo, number, body, event)`
- `mcp__github__list_commits(repo, sha)`

### Surface 2: Sandbox `gh` + `git` (for code, repo ops)

Same vault has a `command_secret` credential that injects
`GITHUB_TOKEN=ghs_…` env var on any sandbox subprocess starting with `gh`
or `git`. Agent uses the standard `bash` tool:

```bash
gh issue view 142 --comments          # read full issue
gh pr diff 89                          # read PR diff
gh repo clone acme/api /workspace      # clone via env-injected token
git push origin fix/auth               # push via injected credentials
gh pr create --title "fix: ..." --body "..."
```

For code work: also attach the repo as a `github_repository` resource at
session create. With a live binding, the resource auto-uses the binding's
token (no separate PAT needed) and the repo is pre-cloned to `/workspace`.

## Token lifecycle (automatic)

Installation tokens last ~1 hour. openma refreshes them at three points,
all automatic:

1. **Every webhook dispatch** — when an event triggers a session, a fresh
   token is minted via the App's private key (held only in the integrations
   gateway) and both vault credentials are rotated in place.
2. **Every session create** — when a user starts a session referencing a
   github-tagged vault (e.g. via Console or `POST /v1/sessions`), the
   gateway is asked to refresh first. Best-effort; non-blocking.
3. **On 401 from outbound** — the agent worker's outbound proxy detects
   401 from `api.githubcopilot.com`, calls the gateway to mint a fresh
   token, retries with the new one. Agent never sees the failure.

Net effect: as long as the App install is live, the agent always operates
with a valid token, regardless of session age or how it was triggered.

## Common things to do after bind

| Goal | Command |
|---|---|
| Tighten what the agent can do | `oma github update <pub-id> --caps issue.read,pr.read,comment.write,…` |
| Allow merging PRs | `oma github update <pub-id> --caps …,pr.merge` |
| Rename the persona | `oma github update <pub-id> --persona "NewName"` |
| Change avatar | `oma github update <pub-id> --avatar https://…` |
| Stop the agent | `oma github unpublish <publication-id>` |

> **Note on capability semantics.** OMA-side capability keys are advisory —
> the actual gates are GitHub App permissions (set at install time). `pr.merge`
> in OMA caps is a hint; if the App doesn't have `pull_requests: write` GitHub
> rejects regardless. A future v2 will surface App permissions directly in the
> Console UI and drop the parallel cap vocabulary.

## When you reach a human-required step

Two steps physically need a human in a browser:

1. **Manifest confirm** — clicking "Create GitHub App for <name>" on
   github.com (the App is created under whoever's logged in).
2. **Install approval** — clicking "Install" on the org (org-owner only).

You're acting as the user's agent. **Offer to drive the browser, then take
direction:**

> I'm at the step where the GitHub App needs to be created. Two options:
>
> **a) I can drive your browser for you.** I see a GitHub tab open at
>    github.com. I'd open the manifest URL, click confirm, then click
>    install on the org. Takes ~30 seconds.
>
> **b) Or you do it yourself.** I'll print the manifest URL; you open
>    it, click confirm, click install. Same ~30 seconds.

Browser detection (in rough order of capability):

| Capability | How to detect |
|---|---|
| Browser-automation MCP / SDK | `browser_*`, `playwright_*`, `puppeteer_*` in tool list |
| Browser CLI on PATH | `which agent-browser` or whatever the harness ships |
| Chrome DevTools Protocol | `curl -s http://localhost:9222/json/list \| grep github.com` |
| `WebFetch` only | last resort — doesn't work for the install click (needs session cookies) |

If you don't have any browser tools, skip to (b) directly — but say so.

## Troubleshooting

### Webhook arriving but nothing happens

Check `oma sessions list` for a new session. If none, look at gateway logs:

```bash
wrangler tail -c apps/integrations/wrangler.jsonc | grep github-webhook
```

| `reason=` | Cause |
|---|---|
| `unknown_app` | Webhook URL points at a stale `appOmaId`. Re-bind. |
| `app_pending_install` | Webhook arrived before the install completed. Self-resolves on next event. |
| `missing_or_malformed_signature` | Webhook payload type wrong (must be `application/json`) or App missing webhook secret. |
| `invalid_signature` | Stored secret doesn't match the App's actual secret. With manifest flow this can't happen unless the App was rotated externally; with manual `submit`, double-check `--webhook-secret`. |
| `duplicate_delivery` | Idempotency: GitHub retried. Already handled. |
| `ignored_event_kind` | Not in default matrix (e.g. `push`, plain comment without `@<bot>`). |

### Bot stops responding mid-session

The 1-hour installation token expired AND the on-401 retry failed. Check
the integrations gateway logs for `[github] token refresh failed` warnings.
Common causes: App was uninstalled from the org, App permissions revoked,
private key rotated externally. `oma github get <pub-id>` will show
`status: needs_reauth` if openma detected revocation. Re-bind to recover.

### Bot replying to itself

This shouldn't happen — the parser drops every event where `sender == bot`.
If you see infinite replies, file a bug with the X-GitHub-Delivery id.

## Comparison to Linear

| | Linear | GitHub |
|---|---|---|
| Bot identity | OAuth App (`actor=app`) | GitHub App (`<slug>[bot]`) |
| Registration | Manual form-fill (5 min) | Manifest flow (one click, ~30s) |
| Webhook secret | Linear auto-generates (`lin_wh_…`) | Manifest auto-generates (server-side) |
| Auth on writes | Long-lived OAuth bearer | 1-hour installation token + auto refresh |
| Write surfaces | MCP only | MCP (issues/PRs) + sandbox `gh`/`git` (code) |
| Mention syntax | `@<persona-name>` | `@<slug>[bot]` |
| Per-agent setup | One Linear OAuth App | One GitHub App |
| Admin required | Linear workspace admin | GitHub org owner |
