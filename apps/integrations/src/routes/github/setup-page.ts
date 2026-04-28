import { Hono } from "hono";
import type { Env } from "../../env";
import { buildGitHubContainer } from "../../wire";

// Public landing page for the non-admin handoff flow. The original publisher
// generates a /github-setup/<token> URL and shares it with their org owner.
// The owner opens it (no OMA login required), pastes the GitHub App's
// numeric id, private-key PEM, and webhook secret, then clicks Install.
//
// Security: the token IS the auth — anyone with the URL can complete the
// install. Treat the URL as sensitive. TTL is 7 days; we don't track use.

const app = new Hono<{ Bindings: Env }>();

app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const container = buildGitHubContainer(c.env);

  let form: {
    persona: { name: string; avatarUrl: string | null };
    userId: string;
    agentId: string;
    appOmaId: string;
  };
  try {
    form = await container.jwt.verify<typeof form>(token);
  } catch (err) {
    return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
  }

  return c.html(landingPage({ token, personaName: form.persona.name }));
});

function landingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub App setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; }
    textarea { min-height: 120px; }
    button { margin-top: 16px; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
    .pillbar { display: flex; gap: 6px; flex-wrap: wrap; }
    .pillbar code { font-size: 11px; padding: 2px 6px; }
  </style>
</head>
<body>
  <h1>Install "${escapedName}" GitHub App on your org</h1>
  <p>Someone on your team is publishing OpenMA's <strong>${escapedName}</strong> agent
  to GitHub. GitHub App registration on an org requires an admin — that's where you come in.</p>

  <ol>
    <li>Open <a href="https://github.com/settings/apps/new" target="_blank">GitHub → Settings → Developer settings → New GitHub App</a> (or your org's equivalent at <code>github.com/organizations/&lt;org&gt;/settings/apps/new</code>) and create an App:
      <ul>
        <li>Name: <code>${escapedName}</code></li>
        <li>Homepage URL: anything sensible (your project page is fine)</li>
        <li>Setup URL: copy from the message that brought you here (the field <strong>after install URL is set</strong>) — and tick "Redirect on update"</li>
        <li>Webhook URL: copy from the message that brought you here</li>
        <li>Webhook secret: pick a long random string and remember it</li>
        <li>Permissions (Repository): <span class="pillbar"><code>Contents: Read &amp; write</code> <code>Issues: Read &amp; write</code> <code>Pull requests: Read &amp; write</code> <code>Metadata: Read</code> <code>Actions: Read</code></span></li>
        <li>Subscribe to events: <span class="pillbar"><code>Issues</code> <code>Issue comment</code> <code>Pull request</code> <code>Pull request review</code> <code>Pull request review comment</code> <code>Workflow run</code></span></li>
        <li>"Where can this GitHub App be installed?": Any account (or just yours if private)</li>
      </ul>
    </li>
    <li>After saving, on the App's page download a <strong>private key</strong> (.pem file). Note the <strong>App ID</strong> at the top.</li>
    <li>Paste the App ID, the contents of the .pem file, and the webhook secret you chose:</li>
  </ol>

  <form id="f">
    <label for="appid">App ID</label>
    <input id="appid" name="appid" required autocomplete="off" placeholder="e.g. 1234567">
    <label for="pkey">Private key (full PEM, including BEGIN/END lines)</label>
    <textarea id="pkey" name="pkey" required autocomplete="off" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."></textarea>
    <label for="whsec">Webhook secret</label>
    <input id="whsec" name="whsec" type="password" required autocomplete="off">
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
      msg.textContent = "Validating with GitHub…";
      msg.className = "";
      try {
        const res = await fetch("/github/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            appId: document.getElementById("appid").value.trim(),
            privateKey: document.getElementById("pkey").value,
            webhookSecret: document.getElementById("whsec").value,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to GitHub to install the App on your org…";
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
