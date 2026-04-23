import { Hono } from "hono";
import type { Env } from "../../env";
import { buildSlackContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Public landing page for the non-admin handoff flow. The original publisher
// generates a /slack-setup/<token> URL and shares it with their workspace
// admin. The admin opens it (no OMA login required), pastes their newly-
// registered Slack App credentials, and clicks Install.
//
// Security: the token IS the auth — anyone with the URL can complete the
// install. Treat the URL as sensitive. TTL is 7 days; we don't track use.

const app = new Hono<{ Bindings: Env }>();

app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const container = buildSlackContainer(c.env);

  let form: {
    persona: { name: string; avatarUrl: string | null };
    userId: string;
    agentId: string;
    appId?: string;
  };
  try {
    form = await container.jwt.verify<typeof form>(token);
  } catch (err) {
    return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
  }

  const { slack } = buildProviders(c.env);
  const manifestLaunchUrl = form.appId
    ? slack.buildManifestLaunchUrlFor(form.appId, form.persona.name)
    : null;

  return c.html(
    landingPage({ token, personaName: form.persona.name, manifestLaunchUrl }),
  );
});

function landingPage(opts: {
  token: string;
  personaName: string;
  manifestLaunchUrl: string | null;
}): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  const manifestSection = opts.manifestLaunchUrl
    ? `
  <div class="callout">
    <p style="margin:0 0 8px"><strong>One-click setup</strong> — let Slack pre-configure the App for you.</p>
    <a class="manifest-btn" href="${escapeHtml(opts.manifestLaunchUrl)}" target="_blank" rel="noopener">
      Create Slack App ↗
    </a>
    <p style="margin:8px 0 0;font-size:13px;color:#555">
      Slack will open with the manifest pre-filled. Confirm Create, then come back here and copy the secrets from your new App's <strong>Basic Information</strong> page.
    </p>
  </div>
`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Slack app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 16px; background: #4A154B; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
    .callout { background: #f7f3fb; border: 1px solid #e2d5ee; border-radius: 8px; padding: 14px 16px; margin: 16px 0 24px; }
    .manifest-btn { display: inline-block; padding: 8px 14px; background: #4A154B; color: #fff; border-radius: 6px; text-decoration: none; font-weight: 500; }
    .manifest-btn:hover { background: #611f63; }
    details { margin: 12px 0 16px; }
    summary { cursor: pointer; color: #4A154B; font-weight: 500; }
  </style>
</head>
<body>
  <h1>Set up "${escapedName}" in your Slack workspace</h1>
  <p>Someone on your team is installing OpenMA's <strong>${escapedName}</strong> agent
  into your Slack workspace. Slack app registration requires a workspace admin —
  that's where you come in.</p>

  ${manifestSection}

  <details${opts.manifestLaunchUrl ? "" : " open"}>
    <summary>${opts.manifestLaunchUrl ? "Or set up manually" : "Manual setup steps"}</summary>
    <ol>
      <li>Open <a href="https://api.slack.com/apps" target="_blank">Slack API → Your Apps</a> and click "Create New App" → "From scratch":
        <ul>
          <li>App Name: <code>${escapedName}</code></li>
          <li>Workspace: select yours</li>
        </ul>
      </li>
      <li>In <strong>Basic Information</strong>, copy the <strong>Client ID</strong>,
          <strong>Client Secret</strong>, and <strong>Signing Secret</strong>.</li>
      <li>In <strong>OAuth &amp; Permissions</strong>, paste the <em>Redirect URL</em>
          from the email/Slack message that brought you here.</li>
      <li>In <strong>Event Subscriptions</strong>, paste the <em>Request URL</em>,
          wait for the green "Verified" check, and subscribe to bot events:
          <code>app_mention</code>, <code>message.channels</code>, <code>message.im</code>,
          <code>message.groups</code>, <code>message.mpim</code>, <code>tokens_revoked</code>,
          <code>app_uninstalled</code>.</li>
    </ol>
  </details>

  <p><strong>Paste your App credentials below and click Continue.</strong></p>

  <form id="f">
    <label for="cid">Client ID</label>
    <input id="cid" name="cid" required autocomplete="off">
    <label for="csec">Client Secret</label>
    <input id="csec" name="csec" type="password" required autocomplete="off">
    <label for="ssec">Signing Secret</label>
    <input id="ssec" name="ssec" type="password" required autocomplete="off">
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>

  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating…";
      msg.className = "";
      try {
        const res = await fetch("/slack/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            clientId: document.getElementById("cid").value.trim(),
            clientSecret: document.getElementById("csec").value.trim(),
            signingSecret: document.getElementById("ssec").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to Slack to authorize…";
        msg.className = "ok";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        msg.className = "err";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Link is invalid or expired</h1>
<p>${escapeHtml(message)}</p>
<p>Ask the original sender to generate a new setup link.</p>
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

// Exported for unit tests. Pure function — no I/O, no module-level state.
export const _testInternals = { landingPage };
