# Console dev-loop debugging playbook

Patterns that came out of debugging the console + integrations UI in this
project. Each entry is a real obstacle I hit and the move that unblocked it —
not a generic "check the console" listicle. Save your future self the
half-hour it cost the first time.

## Vite watcher silently dies across pnpm workspace boundaries

**Symptom**: you edit `packages/integrations-ui/src/pages/Foo.tsx`, the file
on disk is correct, `curl http://localhost:5174/@fs/.../Foo.tsx?t=$(date +%s)`
returns the **new** code, but `curl` without the `?t=...` cache-buster
returns **old** code, and the browser keeps rendering the old UI no matter
how many times you `Page.reload`. `tail -f vite.log` shows no `[vite] hmr`
events when you `touch` the file.

**Cause**: Vite's per-URL transform cache only invalidates on a watcher
event. When the source file lives outside the package the dev server was
started from (e.g. console launched from `apps/console` but the file lives
in `packages/integrations-ui`), the file watcher can fail to register on
that path. With chokidar/fsevents on macOS this usually just stays silent.

**Fix**:

```bash
# kill the running vite, nuke the optimizer cache, restart with --force
pkill -f 'apps/console.*vite'
rm -rf apps/console/node_modules/.vite/
cd apps/console && npx vite --force
```

Browser hard-reload alone does **not** fix this — the dev server is still
serving its cached transform. Verify the fix worked with the cache-buster
curl: it should now return the same code with or without `?t=`.

## CDP session-cookie injection (when you can't log in via the form)

**Symptom**: you need to test an authed Console page in the live browser,
but you don't have the test user's password. Or you accidentally cleared
cookies (`Network.clearBrowserCookies` from CDP) and got logged out.

**Don't** try the password form unless you actually know the password.
**Do** mint a fresh session via the email-OTP backdoor (works in dev because
the OTP is stored in the local D1 verification table):

```bash
# 1. trigger an OTP
curl -X POST http://localhost:5174/auth/email-otp/send-verification-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"claude-test@example.com","type":"sign-in"}'

# 2. fish the OTP out of D1
cd apps/main && npx wrangler d1 execute openma-auth --local --command \
  "SELECT value FROM verification WHERE identifier = 'sign-in-otp-claude-test@example.com' ORDER BY expiresAt DESC LIMIT 1"
# value is "<code>:0"

# 3. exchange OTP for a session, capture the cookie
curl -c /tmp/cookies.txt -X POST http://localhost:5174/auth/sign-in/email-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"claude-test@example.com","otp":"123456"}'

# 4. inject the cookie into the live browser tab via CDP
grep better-auth.session_token /tmp/cookies.txt
# pass the value verbatim (URL-encoded) to Network.setCookie via CDP
```

Gotcha: the cookie value contains `%2F`/`%2B`/`%3D` (URL-encoded `/`/`+`/`=`).
better-auth expects it in that exact form — pass it as-is to
`Network.setCookie`, do **not** decode it.

The session is short-lived in dev (~7 days but the harness session is
shorter); if it expires mid-debug, repeat. Don't cache the value in scripts.

## Targeting the right Chrome tab

`agent-browser connect 9333` grabs the first tab in `/json/list` order, which
may not be the one you want — especially if you have a staging tab open in
the same browser as your local dev tab. Always disambiguate:

```bash
# enumerate tabs filtered to localhost dev
curl -s http://localhost:9333/json/list | python3 -c "
import sys, json
print(json.dumps([
  {'id': t['id'], 'url': t['url'], 'title': t['title']}
  for t in json.load(sys.stdin)
  if t.get('type') == 'page' and 'localhost' in t.get('url', '')
], indent=2))"
```

Then drive that specific tab via its `webSocketDebuggerUrl`. A small Node
script with the `ws` package is more reliable than `agent-browser` here —
`agent-browser` re-resolves "current tab" every call and can drift when
multiple localhost tabs are open.

## "Vite serves new code, browser still shows old"

Two distinct failure modes look identical. Diagnose before trying fixes:

```bash
# A: is the dev server transforming the new code?
curl -s "http://localhost:5174/path/to/Foo.tsx?t=$(date +%s)" | grep -c NEW_STRING

# B: is the browser fetching the new code?
agent-browser eval "fetch('/path/to/Foo.tsx', {cache:'no-store'}).then(r=>r.text()).then(t=>t.includes('NEW_STRING'))"
```

- A=0, B=anything → file wasn't saved, or you edited the wrong file. `ls -la`
  the path on disk.
- A>0, B=false → browser memory cache. `Page.reload` with `ignoreCache: true`
  via CDP, or close + reopen the tab.
- A=0 even with cache-buster → Vite's transform cache is stuck. Restart
  vite (see "Vite watcher silently dies" above).
- A>0, B=true, page still old → React module graph hasn't re-imported.
  Full document navigation (`Page.navigate` to a different URL, then back),
  not React Router pushState.

## Inspecting the live React DOM cheaply

Don't take screenshots when you don't need to. Text-only is faster and lets
you grep:

```bash
agent-browser eval "document.body.innerText"            # full text
agent-browser eval "document.title + ' / ' + location.href"
agent-browser eval "document.querySelector('h1')?.textContent"
```

Use screenshots when you actually need to *see* layout / color / spacing —
they're slow to take, slow to render, and burn context. A 100-char
`document.body.innerText` snippet usually answers "did my change land?"

## When the inner scroll container hides content

If `agent-browser screenshot --full` produces a screenshot that's clearly
shorter than the page, the page has an inner `overflow: auto` container
(common pattern: `<div className="flex-1 overflow-y-auto">`). The full-page
mode captures the *outer* document, not the inner scroller. Either:

- Scroll inside the right container before screenshotting:
  `document.querySelector('.flex-1.overflow-y-auto').scrollTop = 800`, then
  screenshot.
- Use `el.scrollIntoView({block: 'start'})` to jump directly to the section
  you care about.

## Save the noisy stuff

Anything that took >5 minutes to figure out belongs here. Future-you
debugging the same symptom three months later won't remember the fix —
they'll just feel the same dread.
