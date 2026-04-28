# Lanes — ephemeral parallel deploys

A **lane** is a copy of OMA's three Cloudflare Workers (`main`, `agent`,
`integrations`) deployed under unique names, intended for short-lived
per-PR / per-feature testing. Lane code is isolated; lane data is **shared
with staging** (never prod).

## TL;DR

```bash
# Deploy lane "pr-123" from the current branch
gh workflow run deploy-lane.yml \
  -F lane_name=pr-123 \
  -F confirm_shared_data=true

# Lane is reachable at:
#   https://managed-agents-lane-pr-123.<CF_SUBDOMAIN>.workers.dev

# Tear down when done
gh workflow run teardown-lane.yml \
  -F lane_name=pr-123 \
  -F confirm=true
```

## What's isolated, what's shared

| Resource | Lane | Note |
|---|---|---|
| Worker code | **isolated** | Each lane runs its own `git_ref` |
| `SESSION_DO` storage | **isolated** | Per-worker DO namespace; lane sessions are not visible to staging or prod |
| `Sandbox` containers | **isolated** | Each lane builds + runs its own sandbox image |
| `CONFIG_KV` | shared with staging | Tenant data, agent configs, vault snapshots |
| `AUTH_DB` (D1) | shared with staging | Users, agents, environments, sessions metadata (`openma-auth-staging`) |
| Integrations D1 | shared with staging | OAuth tokens, GitHub installation creds |
| `FILES_BUCKET` / `WORKSPACE_BUCKET` / `BACKUP_BUCKET` (R2) | shared with staging | (R2 buckets are physically the same as prod's, but lane-side mutations originate from the staging code path) |
| `VECTORIZE` (memory-search) | shared with staging | Memory store embeddings |
| `AI`, `BROWSER`, `SEND_EMAIL` | shared (account-scoped CF bindings) | |
| Rate-limit namespaces | shared with staging | Lane traffic counts against staging RL counters, not prod |
| Analytics dataset (`oma_events_staging`) | shared with staging | Events from all lanes land here, separated from prod's `oma_events` |
| Cron triggers (`* * * * *`) | **disabled on lanes** | Lane main workers do NOT run eval-runner |

## Risks (you must understand these before deploying a lane)

1. **A lane writing to staging data is a real staging write.** A buggy
   migration on a lane will corrupt staging KV / D1 the same as a buggy
   staging deploy. Don't run destructive code on a lane that you wouldn't
   run on staging.
2. **D1 schema must be compatible with what's deployed to staging.** Lane
   code only sees columns that already exist in `openma-auth-staging`.
   Don't add a column on a lane and then deploy code that reads it — the
   lane will 500.
3. **Linear / GitHub / Slack OAuth callbacks** posted by your lane's
   `integrations` worker write into staging's integrations D1. If your
   lane code messes with token storage, staging sessions can break.
4. **Rate limits are global per `namespace_id`.** A misbehaving lane that
   spams `/v1/sessions` will eat into staging's `RL_SESSIONS_TENANT`
   budget.
5. **Sandbox container costs amplify.** Each lane gets its own
   `sandbox-default-lane-<name>` worker with its own container image and
   `max_instances: 50`. Five live lanes = 250 potential container
   instances.
6. **Tear down promptly.** Lanes don't auto-expire (until reclaim-lanes
   runs at 03:17 UTC daily, 7-day threshold). Stale lane workers keep
   their DO storage rows around indefinitely otherwise.

## How it works

`scripts/lane-generate.mjs` reads each prod `wrangler.jsonc`, deep-merges
the `env.staging` block over the top-level (replacing resource bindings
and analytics dataset), then mutates:

- Sets unique `name` per worker (`*-lane-<name>` suffix)
- Rebinds `services` arrays so lane workers point at lane peers
- Sets `vars.INTEGRATIONS_ORIGIN` / `vars.GATEWAY_ORIGIN` to the lane's
  workers.dev URL (lane Linear webhooks land on the lane, not staging)
- Sets `vars.TURNSTILE_SITE_KEY` to Cloudflare's always-pass test value
- Strips `routes` (lanes use workers.dev, no custom domain)
- Strips `triggers.crons` (no eval-runner on lanes)
- Strips `env.*` (lane configs are flat, no further env nesting)

Output goes to `apps/<worker>/wrangler.lane-<name>.jsonc` (gitignored).


## Local dry-run

```bash
CF_SUBDOMAIN=youraccount node scripts/lane-generate.mjs my-test --check
```

`--check` prints what would be written without touching disk. Useful for
verifying what a lane config will look like before paying for the deploy.

Without `--check`, the same command writes the three lane jsonc files; you
can then `cat apps/main/wrangler.lane-my-test.jsonc | jq .` to inspect.

## Deploy mechanics

The `deploy-lane.yml` workflow does:

1. Check out the requested `git_ref`
2. `pnpm install` + build the console (lane main needs `apps/console/dist`)
3. Run `lane-generate.mjs` with `CF_SUBDOMAIN` from repo vars
4. `wrangler deploy` integrations → agent → main (in this order, so service
   bindings resolve at deploy time)
5. Propagate essential secrets via `wrangler secret put` (API_KEY,
   ANTHROPIC_API_KEY, etc.) from repo secrets
6. `curl /health` on the lane's main URL to confirm green

Required CI vars/secrets (already used by `deploy.yml`):
- `vars.CF_SUBDOMAIN` — your Cloudflare account workers.dev subdomain
- `vars.CLOUDFLARE_ACCOUNT_ID`
- `secrets.CLOUDFLARE_API_TOKEN`
- `secrets.API_KEY`, `secrets.ANTHROPIC_API_KEY`, `secrets.BETTER_AUTH_SECRET`,
  `secrets.INTEGRATIONS_INTERNAL_SECRET`, `secrets.MCP_SIGNING_KEY`,
  `secrets.INTERNAL_TOKEN`
- Optional: `secrets.ANTHROPIC_BASE_URL`, `secrets.TAVILY_API_KEY`

Lanes use Cloudflare's published always-pass Turnstile keys (site
`1x00000000000000000000AA` / secret `1x0000000000000000000000000000000AA`)
hardcoded into `lane-generate.mjs` and `deploy-lane.yml` so `/auth/*`
flows work without exposing prod's real Turnstile secret to lane workers.
Don't sign up with sensitive credentials on a lane — AUTH_DB is shared
with prod, so the user record persists.

If a secret isn't in the repo, the deploy step skips it silently and the
lane comes up without that capability — you can `wrangler secret put` it
manually after.

## Teardown mechanics

`teardown-lane.yml` runs `wrangler delete --force` on the three lane
workers in reverse order (main → agent → integrations). DO storage is
deleted with the worker. Shared resources (KV / D1 / R2 / Vectorize) are
NOT touched — anything the lane wrote there stays.

## Limits & follow-ups (not in MVP)

- No PR-trigger auto-deploy. Lanes are workflow_dispatch only.
- No wildcard DNS / pretty subdomain — lanes use raw workers.dev URLs.
- No per-lane rate-limit namespaces. Lanes share prod RL counters.
- No lane registry / index. Find your lanes via `wrangler list`.
- No auto-expire. Operators must remember to tear down.
- Console asset is built fresh on each deploy (no caching across lanes).
