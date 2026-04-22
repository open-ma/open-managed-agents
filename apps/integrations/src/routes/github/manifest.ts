import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// GitHub App Manifest flow:
//
//   GET  /github/manifest/start/:formToken
//     → renders an HTML page whose <form> auto-POSTs the manifest JSON to
//       https://github.com/settings/apps/new?state=<our state>. User clicks
//       "Create GitHub App for <name>" on GitHub. GitHub fires up the App
//       and redirects to our callback with ?code=...&state=...
//
//   GET  /github/manifest/callback?code=...&state=...
//     → exchanges code via POST /app-manifests/{code}/conversions, persists
//       App credentials, then redirects the user's browser to the install
//       URL so they can pick which org / repos to install on.
//
// Why this exists: the manual path (download .pem, copy App ID, paste
// webhook secret, etc.) takes ~5 minutes; manifest flow takes ~30 seconds.

const app = new Hono<{ Bindings: Env }>();

app.get("/start/:formToken", async (c) => {
  const formToken = c.req.param("formToken");
  if (!formToken) {
    return c.html(errorPage("missing form token"), 400);
  }
  const container = buildContainer(c.env);
  const { github } = buildProviders(c.env, container);

  let prepared;
  try {
    prepared = await github.prepareManifestForm(formToken);
  } catch (err) {
    return c.html(
      errorPage(`form token rejected: ${err instanceof Error ? err.message : String(err)}`),
      400,
    );
  }

  return c.html(
    formPage({
      manifestJson: JSON.stringify(prepared.manifest),
      state: prepared.state,
      personaName: prepared.suggestedAppName,
    }),
  );
});

app.get("/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return c.html(errorPage("missing code or state in GitHub redirect"), 400);
  }

  const container = buildContainer(c.env);
  const { github } = buildProviders(c.env, container);

  let result;
  try {
    result = await github.continueInstall({
      publicationId: null,
      payload: { kind: "manifest_callback", code, state },
    });
  } catch (err) {
    return c.html(
      errorPage(`manifest exchange failed: ${err instanceof Error ? err.message : String(err)}`),
      500,
    );
  }
  if (result.kind !== "step" || result.step !== "install_link") {
    return c.html(errorPage("unexpected manifest result"), 500);
  }

  // Auto-redirect to GitHub's install URL. The user's already in the flow;
  // a no-click bounce keeps the path tight. If they want to inspect first,
  // the page also surfaces the URL.
  const installUrl = result.data.url as string;
  const returnUrl = (result.data.returnUrl as string) ?? "";
  return c.html(autoRedirectPage({ installUrl, returnUrl }));
});

function formPage(opts: {
  manifestJson: string;
  state: string;
  personaName: string;
}): string {
  const manifestB64 = btoa(unescape(encodeURIComponent(opts.manifestJson)));
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Create GitHub App — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px; color: #111; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { color: #444; }
    button { margin-top: 20px; padding: 10px 22px; background: #2da44e; color: #fff; border: 0; border-radius: 6px; font: inherit; font-weight: 500; cursor: pointer; }
    .small { font-size: 13px; color: #666; margin-top: 12px; }
  </style>
</head>
<body>
  <h1>Creating "${escapedName}" on GitHub…</h1>
  <p>Redirecting to GitHub to register your App. You'll be asked to confirm by clicking
     <strong>Create GitHub App for ${escapedName}</strong>.</p>
  <form id="f" action="https://github.com/settings/apps/new" method="post" target="_top">
    <input type="hidden" name="manifest" id="manifest">
    <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
    <button type="submit">Continue to GitHub →</button>
  </form>
  <p class="small">If you want to install the App on an organization instead of your personal account,
     replace <code>https://github.com/settings/apps/new</code> with
     <code>https://github.com/organizations/&lt;org&gt;/settings/apps/new</code> in your URL bar
     before clicking Continue.</p>
  <script>
    // Manifest JSON contains characters that need URL/form-encoding; we
    // base64'd it server-side so the inline payload is HTML-safe, then
    // decode + drop into the hidden field at submit time.
    document.getElementById("manifest").value = decodeURIComponent(escape(atob(${JSON.stringify(manifestB64)})));
    // Auto-submit after a tick so the user sees the redirect happening.
    setTimeout(() => document.getElementById("f").submit(), 250);
  </script>
</body>
</html>`;
}

function autoRedirectPage(opts: { installUrl: string; returnUrl: string }): string {
  const escUrl = escapeHtml(opts.installUrl);
  const escRet = escapeHtml(opts.returnUrl || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>App created — installing…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${escUrl}">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px; color: #111; text-align: center; }
    h1 { margin: 0 0 8px; font-size: 22px; }
  </style>
</head>
<body>
  <h1>App created. Picking org / repos…</h1>
  <p>Redirecting to GitHub to install. If you're not redirected,
     <a href="${escUrl}">click here</a>.</p>
  ${escRet ? `<p style="font-size:13px;color:#666">After install you'll come back to <a href="${escRet}">your console</a>.</p>` : ""}
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Manifest flow error</h1>
<p>${escapeHtml(message)}</p>
<p>Restart the publish flow from <code>oma github bind</code> or your console.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default app;
