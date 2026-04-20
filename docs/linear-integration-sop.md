# Linear Integration — Deployment SOP

**Goal**: take the codebase from "compiled and tested" to "Linear publish flow works end-to-end in production".

**Time**: ~15 minutes if everything goes smoothly. The Linear App registration form takes the longest because it's web-only (no CLI).

**Owner**: this is a one-time setup per environment (dev / prod). After this, the only manual step is rotating secrets if a leak is suspected.

---

## 0. Prerequisites

- Wrangler logged in: `wrangler whoami` shows your Cloudflare account
- Linear workspace **admin** access — required to register OAuth apps
- D1 database `openma-auth` already exists (the main worker uses it)
- The `managed-agents` (main) worker is already deployed
- This branch built clean: `pnpm typecheck && pnpm test` pass

---

## 1. Decide the gateway public URL

The gateway worker (`apps/integrations`) will be deployed under one of two URLs:

- **Default workers.dev**: `https://managed-agents-integrations.<YOUR_SUBDOMAIN>.workers.dev`
  - Find your subdomain: `wrangler subdomain` (or check any existing deployed worker's URL)
- **Custom domain**: `https://integrations.<your-domain>` — needs Cloudflare DNS + wrangler routes config

Whichever you pick, save it as `<GATEWAY>` for the rest of this SOP. Example:

```bash
export GATEWAY="https://managed-agents-integrations.acme.workers.dev"
```

---

## 2. Generate two secrets (one-time)

```bash
# Random 32 bytes, base64. Run twice — DIFFERENT values for each var.
openssl rand -base64 32   # MCP_SIGNING_KEY
openssl rand -base64 32   # INTEGRATIONS_INTERNAL_SECRET
```

Save both to your password manager. The same `MCP_SIGNING_KEY` and `INTEGRATIONS_INTERNAL_SECRET` are set on **both** the gateway worker and the main worker. If they don't match, things fail with "401 unauthorized" or "invalid token".

---

## 3. Register the OMA Linear App

Go to <https://linear.app/settings/api/applications/new> and fill the form:

| Field | Value |
|---|---|
| **Name** | `OpenMA` (or whatever you want users to see — this is the "B+ shared bot" identity) |
| **Description** | `Make your OMA agents teammates in Linear` (or anything) |
| **Developer URL** | Any HTTPS URL — your homepage / repo |
| **Callback URL** | `${GATEWAY}/linear/oauth/shared/callback` |
| **Webhook URL** | `${GATEWAY}/linear/webhook/shared` |
| **Webhook events** | ✅ **App user notification** (required); optionally ✅ Issue, ✅ Comment |
| **Public** | Off (Private — only your installs use it) |
| **Scopes** | ✅ `read`, ✅ `write`, ✅ `app:assignable`, ✅ `app:mentionable` |

Click **Create application**. Linear shows you three values — copy each:

```
LINEAR_APP_CLIENT_ID       (visible on the app page)
LINEAR_APP_CLIENT_SECRET   (shown ONCE — save now or rotate)
LINEAR_APP_WEBHOOK_SECRET  (shown ONCE — save now or rotate)
```

If you lose `CLIENT_SECRET` or `WEBHOOK_SECRET`, rotate them in the same UI.

---

## 4. Set `GATEWAY_ORIGIN` in the gateway config

Edit `apps/integrations/wrangler.jsonc` — replace the placeholder:

```diff
   "vars": {
-    "GATEWAY_ORIGIN": "https://managed-agents-integrations.example.workers.dev"
+    "GATEWAY_ORIGIN": "<GATEWAY>"        // your real URL from step 1
   },
```

Commit this change. (Different env? Use a `[env.production]` block, but for one-env setups just edit in place.)

---

## 5. Deploy the gateway worker

```bash
cd apps/integrations

# Set the 5 secrets (paste the value when prompted)
wrangler secret put LINEAR_APP_CLIENT_ID
wrangler secret put LINEAR_APP_CLIENT_SECRET
wrangler secret put LINEAR_APP_WEBHOOK_SECRET
wrangler secret put MCP_SIGNING_KEY                # from step 2
wrangler secret put INTEGRATIONS_INTERNAL_SECRET   # from step 2

# Deploy
wrangler deploy
```

**Verify**:

```bash
curl $GATEWAY/health
# → {"status":"ok"}
```

If you get HTML instead of JSON, the URL is wrong (probably hitting your main worker). Re-check.

---

## 6. Deploy the main worker

```bash
cd apps/main

# Same two secrets — MUST match step 2's values exactly
wrangler secret put MCP_SIGNING_KEY
wrangler secret put INTEGRATIONS_INTERNAL_SECRET

wrangler deploy
```

**Order matters**: gateway must be deployed FIRST so main's `INTEGRATIONS` service binding can resolve.

**Verify** (need a logged-in session cookie or skip):

```bash
curl -b 'session=...' https://<MAIN>/v1/integrations/linear/installations
# → {"data":[]}
```

If you see `INTEGRATIONS binding missing`, the gateway wasn't deployed yet — re-run step 5 then re-deploy main.

---

## 7. Apply D1 migrations

```bash
# From repo root or apps/main:
wrangler d1 migrations apply openma-auth --remote

# (For local dev: --local instead)
```

Migrations applied:

```
0002_integrations_tables.sql        6 new linear_* tables + indexes
0003_publications_environment.sql   adds environment_id column
0004_installations_vault.sql        adds vault_id column
```

If a migration fails because a table already exists from a previous attempt, drop the half-applied tables manually with `wrangler d1 execute openma-auth --remote --command 'DROP TABLE linear_xxx'` then re-apply.

---

## 8. End-to-end smoke test

### 8a. Open Console

Browse to your Console URL, log in. Sidebar should now show **Integrations / Linear**. Click it.

You should see:
- "No Linear workspaces connected yet."
- A `+ Publish agent to Linear` button.

### 8b. Publish an agent (B+ — fastest)

1. Click `+ Publish agent to Linear`
2. Pick any existing agent
3. Pick any environment
4. Persona name: defaults to agent name, OK as-is
5. Identity mode: **Quick try (shared bot)**
6. Click `Continue →`

Browser redirects to Linear. Authorize the install. After Linear redirects back, you should land on `/integrations/linear?install=ok&publication_id=...`.

### 8c. Verify the install in Linear

In your Linear workspace:
- Settings → Members should show "OpenMA" (or whatever you named it) as a bot user
- Try `@OpenMA` in any issue — autocomplete should find it
- Assign the issue to OpenMA

Within ~10 seconds you should see:
- A new session in OMA Console at `/sessions`, with a 🔗 ENG-XXX badge
- Possibly an agent comment back in the Linear issue (if your agent does that)

### 8d. Tail logs while testing

In separate terminals:

```bash
wrangler tail managed-agents-integrations
wrangler tail managed-agents
```

Look for:
- Gateway: `POST /linear/webhook/shared` with 200
- Main: `POST /v1/internal/sessions` with 200, sessionId returned

Common failures:
- **401 from gateway webhook** — `LINEAR_APP_WEBHOOK_SECRET` doesn't match what Linear has. Re-set the secret.
- **401 from main internal endpoint** — `INTEGRATIONS_INTERNAL_SECRET` differs between gateway and main. Re-set on both, redeploy.
- **No webhook arrives at all** — Linear didn't recognize the URL. Re-check the webhook URL in Linear's app settings; it must be exactly `${GATEWAY}/linear/webhook/shared`.

---

## 9. (Optional) Try A1 mode

In Console, click `+ Publish agent to Linear` again, but pick **Full identity (recommended)**. Follow the wizard:

1. Console returns the form values to paste into Linear's app registration page.
2. Open `https://linear.app/settings/api/applications/new` in a new tab.
3. Paste each copied value.
4. Linear gives you `client_id` + `client_secret` — paste back into Console.
5. Console returns an install URL. Click it.
6. Authorize in Linear. Redirected back to Console with the new publication live.

In Linear, this agent now appears as its own user (not "OpenMA") with `@CoderName` autocomplete and a slot in the assignee dropdown.

---

## 10. Rotation / teardown

### Rotate `LINEAR_APP_CLIENT_SECRET` or `LINEAR_APP_WEBHOOK_SECRET`

1. In Linear app settings, click "Regenerate" for the secret.
2. `wrangler secret put LINEAR_APP_CLIENT_SECRET` (or webhook) — paste new value.
3. `wrangler deploy` the gateway.

### Rotate `MCP_SIGNING_KEY`

⚠️ **Destructive**: rotating this orphans all encrypted-at-rest tokens (`linear_installations.access_token_cipher`, `linear_apps.client_secret_cipher`, etc.). Existing publications will fail with "missing client secret" until they're re-installed.

Process:
1. `wrangler secret put MCP_SIGNING_KEY` on **both** workers.
2. `wrangler deploy` both.
3. Tell users to re-publish their Linear integrations from Console.

### Rotate `INTEGRATIONS_INTERNAL_SECRET`

Just put new value on both workers and redeploy. No data loss.

### Uninstall the OMA Linear App entirely

1. In Linear → Settings → Apps, uninstall "OpenMA" from each workspace.
2. In Linear → Settings → API, delete the app registration.
3. Drop the linear_* tables in D1 if you want to wipe state:
   ```bash
   wrangler d1 execute openma-auth --remote --command \
     'DROP TABLE linear_apps; DROP TABLE linear_installations;
      DROP TABLE linear_publications; DROP TABLE linear_webhook_events;
      DROP TABLE linear_setup_links; DROP TABLE linear_issue_sessions;'
   ```

---

## Appendix A — Local dev

Skip step 1 (no public URL needed). Use `wrangler dev` for both workers:

```bash
# Terminal 1 — gateway
cd apps/integrations
echo 'GATEWAY_ORIGIN = "http://localhost:8788"' > .dev.vars
echo 'LINEAR_APP_CLIENT_ID = "..."' >> .dev.vars
# (etc — all 5 secrets)
wrangler dev --port 8788

# Terminal 2 — main
cd apps/main
echo 'MCP_SIGNING_KEY = "..."' > .dev.vars
echo 'INTEGRATIONS_INTERNAL_SECRET = "..."' >> .dev.vars
wrangler dev --port 8787
```

Linear can't webhook a localhost URL, so end-to-end OAuth + webhook flow needs **cloudflared tunnel** or **ngrok** to expose the gateway publicly. Then update Linear's app callback / webhook URLs to point at the tunnel URL temporarily.

For "click around the Console UI without real Linear traffic", localhost is fine — the install button will fail at the OAuth redirect step but everything before that works.

---

## Appendix B — Pre-filled values cheatsheet

Save this somewhere, paste during the Linear form fill:

```
App name:           OpenMA
Description:        Make your OMA agents teammates in Linear
Developer URL:      https://github.com/yourorg/open-managed-agents
Callback URL:       <GATEWAY>/linear/oauth/shared/callback
Webhook URL:        <GATEWAY>/linear/webhook/shared
Webhook events:     App user notification, Issue (optional), Comment (optional)
Scopes:             read, write, app:assignable, app:mentionable
Public:             No
```
