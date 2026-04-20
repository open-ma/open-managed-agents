import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";

// Public landing page for the non-admin handoff flow. The original publisher
// generates a /linear-setup/<token> URL and shares it with their workspace
// admin. The admin opens it (no OMA login required), pastes their newly-
// registered Linear App credentials, and clicks Install.
//
// Security: the token IS the auth — anyone with the URL can complete the
// install. Treat the URL as sensitive. TTL is 7 days; we don't track use.
//
// Rendering is plain server-side HTML — no React, no JS framework. Console
// users have a richer UI for the same flow; this page is the bare minimum
// for handing off to admins who may not have OMA accounts.

const app = new Hono<{ Bindings: Env }>();

app.get("/:token", async (c) => {
  const token = c.req.param("token");
  const container = buildContainer(c.env);

  let form: {
    persona: { name: string; avatarUrl: string | null };
    userId: string;
    agentId: string;
  };
  try {
    form = await container.jwt.verify<typeof form>(token);
  } catch (err) {
    return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
  }

  return c.html(landingPage({ token, personaName: form.persona.name }));
});

function landingPage(opts: { token: string; personaName: string }): string {
  // Inline form posts to /linear/publications/credentials with the token
  // we received. On success, redirect to the install URL.
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Linear app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
  </style>
</head>
<body>
  <h1>Set up "${escapedName}" in your Linear workspace</h1>
  <p>Someone on your team is installing OpenMA's <strong>${escapedName}</strong> agent
  into your Linear workspace. Linear app registration requires a workspace admin —
  that's where you come in.</p>

  <ol>
    <li>Open <a href="https://linear.app/settings/api" target="_blank">Linear → Settings → API</a> and create a new OAuth app:
      <ul>
        <li>Name: <code>${escapedName}</code></li>
        <li>Callback URL and Webhook URL: copy from the email/Slack message that brought you here</li>
        <li>Scopes: read, write, app:assignable, app:mentionable</li>
      </ul>
    </li>
    <li>Linear will give you <strong>Client ID</strong> and <strong>Client Secret</strong>. Paste them below.</li>
    <li>Click "Continue" and approve the install in your Linear workspace.</li>
  </ol>

  <form id="f">
    <label for="cid">Client ID</label>
    <input id="cid" name="cid" required autocomplete="off">
    <label for="csec">Client Secret</label>
    <input id="csec" name="csec" type="password" required autocomplete="off">
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
        const res = await fetch("/linear/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            clientId: document.getElementById("cid").value.trim(),
            clientSecret: document.getElementById("csec").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to Linear to authorize…";
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
