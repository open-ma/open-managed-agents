import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// GitHub App "Setup URL" callback — where GitHub redirects after the user
// installs the App on their org. Per-app endpoint so each App's install
// completion is unambiguous from the URL alone.
//
// GitHub query params on this redirect:
//   installation_id  — numeric, the new install id we exchange for tokens
//   setup_action     — "install" | "update" | "request"
//   state            — round-tripped from our buildInstallUrl({state})
//   code             — only set when the App also requests OAuth (not us)

const app = new Hono<{ Bindings: Env }>();

app.get("/:appOmaId/callback", async (c) => {
  const appOmaId = c.req.param("appOmaId");
  const url = new URL(c.req.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return c.json({ error: "github_install_denied", details: error }, 400);
  }
  if (!appOmaId || !installationId || !state) {
    return c.json(
      { error: "missing appOmaId, installation_id, or state" },
      400,
    );
  }
  if (setupAction === "request") {
    // The org admin requested install (no permission). Our App can't proceed.
    return c.html(
      requestPendingPage(setupAction),
      200,
    );
  }

  const container = buildContainer(c.env);
  const { github } = buildProviders(c.env, container);

  let result;
  try {
    result = await github.continueInstall({
      publicationId: null,
      payload: {
        kind: "install_callback",
        appOmaId,
        installationId,
        state,
      },
    });
  } catch (err) {
    return c.json(
      {
        error: "install_failed",
        details: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }

  if (result.kind !== "complete") {
    return c.json({ error: "unexpected install result", result }, 500);
  }

  // Recover the Console returnUrl from the (still-valid) state JWT.
  const statePayload = await container.jwt.verify<{ returnUrl: string }>(state);
  const target = new URL(statePayload.returnUrl);
  target.searchParams.set("publication_id", result.publicationId);
  target.searchParams.set("install", "ok");
  return c.redirect(target.toString(), 302);
});

function requestPendingPage(action: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Install requested</h1>
<p>The GitHub App install request was sent to an org owner (action: <code>${escapeHtml(action)}</code>).
Once they approve, GitHub will redirect here again with <code>setup_action=install</code> and OMA will
finish the publish then. You can close this tab.</p>
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
