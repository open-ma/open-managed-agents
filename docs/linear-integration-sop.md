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
openssl rand -base64 32   # PLATFORM_ROOT_SECRET
openssl rand -base64 32   # INTEGRATIONS_INTERNAL_SECRET
```

Save both to your password manager. The same `PLATFORM_ROOT_SECRET` and `INTEGRATIONS_INTERNAL_SECRET` are set on **both** the gateway worker and the main worker. If they don't match, things fail with "401 unauthorized" or "invalid token".

---

## 3. (Per agent) Register a Linear App

Each agent you publish needs its own Linear OAuth App. The Console publish wizard tells you exactly what to paste — but for reference, the form is:

| Field | Value |
|---|---|
| **Name** | The agent's persona name (shown in Linear's `@` autocomplete and assignee list) |
| **Description** | Free text |
| **Developer URL** | Any HTTPS URL — your homepage / repo |
| **Callback URL** | `${GATEWAY}/linear/oauth/app/<APP_ID>/callback` (Console regenerates with the real `<APP_ID>` after step 2) |
| **Webhook URL** | `${GATEWAY}/linear/webhook/app/<APP_ID>` |
| **Webhook secret** | Console generates one — paste it into Linear |
| **Webhook events** | ✅ **App user notification** (required); optionally ✅ Issue, ✅ Comment |
| **Public** | Off (Private — only your installs use it) |
| **Scopes** | ✅ `read`, ✅ `write`, ✅ `app:assignable`, ✅ `app:mentionable` |

Linear shows you `client_id` + `client_secret` once. Paste both back into the Console wizard.

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

# Set the 2 secrets (paste the value when prompted)
wrangler secret put PLATFORM_ROOT_SECRET                # from step 2
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
wrangler secret put PLATFORM_ROOT_SECRET
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
0005_drop_b_plus_columns.sql        drops slash_command + is_default_agent
```

If a migration fails because a table already exists from a previous attempt, drop the half-applied tables manually with `wrangler d1 execute openma-auth --remote --command 'DROP TABLE linear_xxx'` then re-apply.

---

## 8. End-to-end smoke test

### 8a. Open Console

Browse to your Console URL, log in. Sidebar should now show **Integrations / Linear**. Click it.

You should see:
- "No Linear workspaces connected yet."
- A `+ Publish agent to Linear` button.

### 8b. Publish an agent

1. Click `+ Publish agent to Linear`
2. Pick any existing agent
3. Pick any environment
4. Persona name: defaults to agent name, OK as-is
5. Click `Continue →`

The wizard hands you a Linear app registration form (App name, Callback URL, Webhook URL, Webhook secret) — paste those into <https://linear.app/settings/api/applications/new>, then paste the `client_id` + `client_secret` Linear gives you back into the Console. Click the install link, authorize in Linear, and you'll land on `/integrations/linear?install=ok&publication_id=...`.

### 8c. Verify the install in Linear

In your Linear workspace:
- Settings → Members should show the agent (under whatever Persona name you used) as a bot user
- Try `@<persona-name>` in any issue — autocomplete should find it
- Assign the issue to it

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
- Gateway: `POST /linear/webhook/app/<APP_ID>` with 200
- Main: `POST /v1/internal/sessions` with 200, sessionId returned

Common failures:
- **401 from gateway webhook** — webhook secret stored on the App row doesn't match what Linear has. Re-paste in Linear's app settings.
- **401 from main internal endpoint** — `INTEGRATIONS_INTERNAL_SECRET` differs between gateway and main. Re-set on both, redeploy.
- **No webhook arrives at all** — Linear didn't recognize the URL. Re-check the webhook URL in Linear's app settings; it must be exactly `${GATEWAY}/linear/webhook/app/<APP_ID>`.

---

## 9. (Optional) Smoke-test from CLI

If you've already published an agent in step 8, you can validate from the terminal:

```bash
# Confirm Console sees the install
curl -b 'session=...' https://<MAIN>/v1/integrations/linear/installations
# → {"data":[{"workspace_name":"...","install_kind":"dedicated",...}]}
```

In Linear, this agent appears as its own user with `@<persona>` autocomplete and a slot in the assignee dropdown.

---

## 10. Rotation / teardown

### Rotate per-app `client_secret` or `webhook_secret`

Per-app secrets live in D1 (`linear_apps.client_secret_cipher` / `webhook_secret_cipher`), encrypted with `PLATFORM_ROOT_SECRET`. To rotate one publication's secrets without rotating `PLATFORM_ROOT_SECRET`:

1. In Linear app settings, click "Regenerate" for the secret.
2. Re-publish from Console (the wizard re-encrypts and writes the new value).

### Rotate `PLATFORM_ROOT_SECRET`

⚠️ **Destructive**: rotating this orphans all encrypted-at-rest tokens (`linear_installations.access_token_cipher`, `linear_apps.client_secret_cipher`, etc.). Existing publications will fail with "missing client secret" until they're re-installed.

Process:
1. `wrangler secret put PLATFORM_ROOT_SECRET` on **both** workers.
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
echo 'PLATFORM_ROOT_SECRET = "..."' >> .dev.vars
echo 'INTEGRATIONS_INTERNAL_SECRET = "..."' >> .dev.vars
wrangler dev --port 8788

# Terminal 2 — main
cd apps/main
echo 'PLATFORM_ROOT_SECRET = "..."' > .dev.vars
echo 'INTEGRATIONS_INTERNAL_SECRET = "..."' >> .dev.vars
wrangler dev --port 8787
```

Linear can't webhook a localhost URL, so end-to-end OAuth + webhook flow needs **cloudflared tunnel** or **ngrok** to expose the gateway publicly. Then update Linear's app callback / webhook URLs to point at the tunnel URL temporarily.

For "click around the Console UI without real Linear traffic", localhost is fine — the install button will fail at the OAuth redirect step but everything before that works.

---

## Appendix B — Pre-filled values cheatsheet (for the Linear app form)

```
App name:           <persona name from publish wizard>
Description:        Make this OMA agent a teammate in Linear
Developer URL:      https://github.com/yourorg/open-managed-agents
Callback URL:       <GATEWAY>/linear/oauth/app/<APP_ID>/callback
Webhook URL:        <GATEWAY>/linear/webhook/app/<APP_ID>
Webhook events:     App user notification, Issue (optional), Comment (optional)
Scopes:             read, write, app:assignable, app:mentionable
Public:             No
```
