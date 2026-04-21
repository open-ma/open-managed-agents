---
name: linear-local-test
description: >
  End-to-end local test of the Linear publish flow on a developer's laptop.
  Use when validating the integrations-gateway worker, the per-agent App
  install path, or any code that touches packages/linear / packages/integrations-*
  / apps/integrations / the linear_* D1 tables. Triggers on any task involving
  testing the OMA Linear integration locally without deploying to production.
---

# Linear Integration — Local End-to-End Test

This skill captures the proven recipe for running the Linear publish flow on
localhost, including the workarounds for issues you'll definitely hit. **Read
this top-to-bottom before starting** — most steps depend on prior ones.

## Architecture refresher

```
Browser (Console UI)  ──►  apps/console (vite, :5174)
                          │
Browser (any)         ──►  apps/main (wrangler dev, :8787)
                          │ ─ /v1/integrations/* (CRUD + proxy to gateway)
                          │ ─ /linear/*           (proxy to gateway, OAuth callback / webhook target)
                          │ ─ /v1/internal/*      (gateway → main, header-secret auth)
                          │
                          └ service binding ──►  apps/integrations (gateway worker)
                                                  │ ─ packages/linear (LinearProvider)
                                                  │ ─ packages/integrations-adapters-cf
                                                  └ ─ packages/integrations-core
```

In production the gateway has its own host (`integrations.<your-domain>`).
**Locally we run main + gateway under the same wrangler instance** so the
service binding works without two ports — and Linear's OAuth callback hits
`http://localhost:8787/linear/oauth/app/<APP_ID>/callback`, which main proxies
into the gateway via the `INTEGRATIONS` service binding.

## One-time prerequisites

```bash
brew install --cask google-chrome             # headed Chrome for OAuth UI
npm i -g agent-browser                        # CLI for Chrome DevTools Protocol
pnpm install                                  # repo deps
```

Optional (only needed for **webhook** testing — Linear can't POST to localhost):

```bash
brew install cloudflared                      # tunnel to expose :8787 publicly
```

## Setup

### 1. Generate two secrets (once per laptop)

```bash
openssl rand -base64 32   # MCP_SIGNING_KEY
openssl rand -base64 32   # INTEGRATIONS_INTERNAL_SECRET
```

### 2. Write `.dev.vars` for both workers (must contain identical values)

`apps/main/.dev.vars`:
```
MCP_SIGNING_KEY=<value-1>
INTEGRATIONS_INTERNAL_SECRET=<value-2>
# plus whatever else apps/main needs (BETTER_AUTH_SECRET, ANTHROPIC_API_KEY, ...)
```

`apps/integrations/.dev.vars`:
```
MCP_SIGNING_KEY=<value-1>
INTEGRATIONS_INTERNAL_SECRET=<value-2>
GATEWAY_ORIGIN=http://localhost:8787
```

The `GATEWAY_ORIGIN` override is critical — it makes the wizard tell Linear to
send callbacks to `localhost:8787` instead of the placeholder URL in
`apps/integrations/wrangler.jsonc`.

### 3. Apply D1 migrations locally

```bash
pnpm exec wrangler d1 migrations apply openma-auth --local --config apps/main/wrangler.jsonc
```

### 4. Start the workers (combined)

```bash
pnpm exec wrangler dev -c apps/main/wrangler.jsonc -c apps/integrations/wrangler.jsonc --port 8787
```

Both workers in one wrangler process means the `MAIN`/`INTEGRATIONS` service
bindings show `[connected]` instead of `[not connected]`. **Do not run them as
two separate `wrangler dev` processes** — service binding won't work.

### 5. Start the Console (vite)

```bash
cd apps/console && npx vite
# typically lands on :5174 because :5173 is often taken by another project
```

## Necessary code changes (real bugs found by this test)

These are not optional — they fix actual bugs in the current codebase. **Commit
them**:

### A. Skip authMiddleware on `/v1/internal/*`

`apps/main/src/auth.ts`, top of `authMiddleware`:

```ts
// Internal endpoints have their own header-secret auth (see routes/internal.ts)
if (c.req.path.startsWith("/v1/internal/")) {
  return next();
}
```

Without this the gateway's calls to `/v1/internal/vaults` and `/v1/internal/sessions`
hit `authMiddleware` (mounted via `app.use("/v1/*", authMiddleware)`) before
`internal.ts`'s own middleware, and get rejected as `Unauthorized` — which
surfaces in the OAuth callback as `VaultManager.createCredentialForUser: 401`.

### B. Proxy `/linear/*` and `/linear-setup/*` from main → integrations

`apps/main/src/index.ts`, after the `/v1/internal` route mount:

```ts
app.all("/linear/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/linear-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
```

In production you'd give the gateway its own host (`integrations.<host>`) and
not need this — but the proxy is harmless to ship and makes both modes work.

## Local-dev hacks (DO NOT commit)

### C. Mirror outgoing emails to console

`apps/main/src/auth-config.ts`, top of `sendEmail`:

```ts
console.log(`[auth dev] email to ${to} | subject: ${subject} | body: ${text}`);
```

Cloudflare's local `SEND_EMAIL` binding is a stub — it doesn't actually deliver
mail. With this line you get the verification link / OTP code in wrangler logs
during signup.

### D. ASSETS handling for OAuth callback

`apps/main/wrangler.jsonc`:

```json
"assets": {
  "directory": "../console/dist",
  "binding": "ASSETS",
  "not_found_handling": "none"          // dev only
}
```

The default `single-page-application` value makes Cloudflare serve `index.html`
for any unknown navigation request — *before* invoking the worker. So the OAuth
callback `GET /linear/oauth/app/.../callback` returns 200 with HTML instead of
running the gateway's handler, and you'll see this in logs:

```
GET /linear/oauth/app/.../callback 200 OK ... `Sec-Fetch-Mode: navigate` header present - using `not_found_handling` behavior
```

`"none"` makes ASSETS pass through to the worker, which has the `/linear/*`
proxy from change B.

For production, a better fix is `run_worker_first: true` plus a worker-side
catch-all that fetches ASSETS — but that's a larger refactor.

## Run the publish flow

### 1. Start an isolated Chrome with CDP

Chrome 136+ refuses `--remote-debugging-port` on the default profile. Use a
dedicated profile and a non-standard port (avoid 9222 — Chrome helpers grab
that port and serve garbage):

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9333 \
  '--remote-allow-origins=*' \
  --user-data-dir="$HOME/.chrome-debug-profile" \
  --no-first-run \
  https://linear.app/ </dev/null 2>&1 &
disown

# verify CDP is listening (must return JSON, not 404)
curl -s http://127.0.0.1:9333/json/version
```

Log in to Linear once in the spawned window — cookies persist in
`~/.chrome-debug-profile` and survive Chrome restarts. **Do not delete that
directory.**

### 2. Connect agent-browser

```bash
agent-browser connect 9333    # use the connect subcommand, not --cdp flag
agent-browser get url         # should now show the Linear page
```

### 3. Sign up + log in to OMA Console

Open `http://localhost:5174/login`, click "Sign up", fill name + email + password.
The verification email is captured in wrangler logs (change C above). Either
click the captured link, or **just patch D1 directly to skip verification**:

```bash
pnpm exec wrangler d1 execute openma-auth --local --config apps/main/wrangler.jsonc \
  --command "UPDATE user SET emailVerified=1 WHERE email='YOUR_EMAIL'"
```

Then sign in normally with email + password.

### 4. Create an agent + environment

The publish wizard's dropdowns are empty if you don't. From the Console UI
(`/agents` and `/environments`) make at minimum one of each — name them
anything, the test agent doesn't need a real model card.

### 5. Walk the publish wizard

1. Console → Integrations → Linear → "+ Publish agent to Linear"
2. Pick the agent + environment, type a persona name (e.g. `ClaudeBot`),
   click **Continue**.
3. Wizard hands you 4 strings: App name, Callback URL (with `<APP_ID>`
   placeholder), Webhook URL, Webhook secret.
4. In the Linear Chrome tab, go to
   `https://linear.app/<workspace>/settings/api/applications/new` and create
   an OAuth app. **Use the placeholder Callback URL for now** — Linear is
   happy with `http://localhost:8787/linear/oauth/app/PLACEHOLDER/callback`.
5. Linear shows you `client_id` + `client_secret`. The secret is masked. To
   capture it via agent-browser, monkey-patch the clipboard:
   ```bash
   agent-browser eval "
   window.__copiedSecrets = [];
   const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
   navigator.clipboard.writeText = (text) => { window.__copiedSecrets.push(text); return orig(text); };
   'patched'"
   agent-browser eval "document.querySelectorAll('button[aria-label*=clipboard]')[1].click()"
   agent-browser eval "JSON.stringify(window.__copiedSecrets)"
   ```
6. Paste both back into the Console wizard, click **Continue** again. The
   wizard now shows the **real** Callback URL (with the OMA APP_ID).
7. Go back to the Linear app's Edit page and replace the placeholder Callback
   URL with the real one. Save.
8. Back in Console, click **Install in Linear**. Linear shows the OAuth
   authorize page — click **Authorize**.
9. Linear redirects to `http://localhost:8787/linear/oauth/app/<APP_ID>/callback?code=...`.
   Main proxies to the gateway, which exchanges the code, creates the
   installation + publication + vault, and redirects to
   `http://localhost:5174/integrations/linear?install=ok&publication_id=...`.

### 6. Verify

```bash
pnpm exec wrangler d1 execute openma-auth --local --config apps/main/wrangler.jsonc \
  --command "SELECT id, status, mode FROM linear_publications"
# expect: status=live, mode=full

pnpm exec wrangler d1 execute openma-auth --local --config apps/main/wrangler.jsonc \
  --command "SELECT install_kind, vault_id FROM linear_installations"
# expect: install_kind=dedicated, vault_id=vlt-...
```

## Gotchas

These bit me, in roughly the order they happened:

- **CDP on default profile**: Chrome ≥136 silently ignores `--remote-debugging-port`
  unless `--user-data-dir` points to a non-default directory. The
  `RemoteDebuggingAllowed` enterprise policy does **not** override this. There
  is no in-browser flag to flip. See `memory/browser-automation.md`.
- **Port 9222 is poisoned**: Chrome occasionally has a helper process listening
  on 9222 that returns HTTP 200 but is not CDP. Always pick a different port
  (9333, 9444, etc.) and verify with `curl http://127.0.0.1:<port>/json/version`.
- **Console + main port mismatch**: vite (5174) and main (8787) are different
  origins. better-auth cookies attach to 8787; vite proxies `/v1`, `/auth`,
  `/auth-info`, `/health` to 8787. Linear OAuth callback redirects to 8787
  (main), not 5174 — that's why we need the `/linear/*` proxy on main.
- **OAuth callback eaten by SPA fallback**: see change D above. If you see
  `Sec-Fetch-Mode: navigate header present - using not_found_handling behavior`
  in wrangler logs, ASSETS swallowed it.
- **VaultManager 401**: see change A above. authMiddleware was rejecting the
  service-binding call before internal.ts could check the header secret.
- **OAuth code is one-shot**: if a callback fails, the `code=` URL param is
  burned. To retry, you need a new code, which means re-authorizing — which
  Linear refuses if the App is "already installed". Workaround: revoke first
  via `https://linear.app/<workspace>/settings/applications`, then re-issue
  the install URL. The state JWT remains valid for 30 minutes.
- **D1 UNIQUE constraint on retry**: half-completed installs leave
  `linear_installations` rows behind. If a callback fails after the install
  row was inserted but before publication creation, the next attempt
  collides. Clean up:
  ```bash
  pnpm exec wrangler d1 execute openma-auth --local --config apps/main/wrangler.jsonc \
    --command "DELETE FROM linear_installations; DELETE FROM linear_publications; DELETE FROM linear_apps"
  ```
- **Two Linear App edits**: Linear requires a callback URL when you create the
  App, but the OMA APP_ID isn't generated until the wizard's step-2 finishes.
  So you create the App with a placeholder, then go back and edit it with the
  real URL. There is no way around this in the current design — add it to the
  wizard's step 1 instructions if you want users not to be confused.
- **Webhook needs a tunnel**: the publish flow above does **not** test
  webhook delivery. Linear can't POST to `localhost`. To exercise the
  webhook path, run `cloudflared tunnel --url http://localhost:8787`,
  copy the public URL, set `GATEWAY_ORIGIN` to it (in
  `apps/integrations/.dev.vars`), restart wrangler, and update the Linear
  App's Webhook URL field via the same Edit flow.

## After you're done

Revert the dev-only changes (C, D in this doc). Keep A and B — they fix real
bugs. The skill assumes you'll commit A+B as part of the integration work
itself.
