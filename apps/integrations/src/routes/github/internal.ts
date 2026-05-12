import { Hono } from "hono";
import type { Env } from "../../env";
import { buildGitHubContainer } from "../../wire";
import { mintAppJwt, buildInstallationTokenRequest, parseInstallationTokenResponse } from "@open-managed-agents/github";

// GitHub-specific internal endpoints, called via service binding from
// apps/main and apps/agent. Auth: shared INTEGRATIONS_INTERNAL_SECRET header.
//
// Single endpoint today: refresh-by-vault. Given a userId + vaultId, looks
// up the GitHub installation linked to that vault, mints a fresh
// installation token using the App's private key (which is stored only here
// in github_apps table — never reaches agent worker), updates both vault
// credentials in place, and returns the new token.
//
// Used for:
//   1. apps/main /v1/sessions create handler — refresh before handing
//      vault to a freshly-spawned session.
//   2. apps/agent outbound proxy — refresh on 401, retry the original call.

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const expected = c.env.INTEGRATIONS_INTERNAL_SECRET;
  if (!expected) {
    return c.json({ error: "internal endpoints not configured" }, 503);
  }
  const provided = c.req.header("x-internal-secret");
  if (!provided || provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

interface RefreshBody {
  userId: string;
  vaultId: string;
}

app.post("/refresh-by-vault", async (c) => {
  const body = await c.req.json<RefreshBody>();
  if (!body.userId || !body.vaultId) {
    return c.json({ error: "userId, vaultId required" }, 400);
  }

  const container = buildGitHubContainer(c.env);

  // Find the github installation that owns this vault.
  const installations = await container.installations.listByUser(body.userId, "github");
  const installation = installations.find((i) => i.vaultId === body.vaultId);
  if (!installation || !installation.appId) {
    return c.json({ error: "no github installation for vault" }, 404);
  }

  const app = await container.githubApps.get(installation.appId);
  if (!app) return c.json({ error: "app row missing" }, 404);

  const privateKey = await container.githubApps.getPrivateKey(app.id);
  if (!privateKey) return c.json({ error: "private key missing" }, 500);

  const appJwt = await mintAppJwt(privateKey, { appId: app.appId });
  const tokReq = buildInstallationTokenRequest(appJwt, installation.workspaceId);
  const tokRes = await container.http.fetch({
    method: "POST",
    url: tokReq.url,
    headers: tokReq.headers,
    body: tokReq.body,
  });
  if (tokRes.status < 200 || tokRes.status >= 300) {
    return c.json(
      { error: "github_token_mint_failed", details: tokRes.body.slice(0, 200) },
      502,
    );
  }
  const fresh = parseInstallationTokenResponse(tokRes.body);

  // Rotate both credentials in the vault to the same fresh token.
  await container.vaults.rotateBearerToken({
    userId: body.userId,
    vaultId: body.vaultId,
    newBearerToken: fresh.token,
  });
  await container.vaults.rotateCapCliToken({
    userId: body.userId,
    vaultId: body.vaultId,
    cliId: "gh",
    newToken: fresh.token,
  });

  return c.json({
    ok: true,
    token: fresh.token,
    expiresAt: fresh.expiresAt,
  });
});

export default app;
