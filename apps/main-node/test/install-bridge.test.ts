// In-process smoke tests for NodeInstallBridge — wires sqlite repos
// against the same services bundle main-node uses, then exercises:
//   - lookupLinearCredentialForSession (Linear MCP route's auth path)
//   - refreshGithubVault is exercised against a mocked github API
//   - startInstallation publication-first paths for Linear
//
// Skips the spawn-process heaviness of the existing crash-recovery /
// promote-sandbox tests; these only need the in-process services + a
// fake fetch.

import { afterEach, describe, it, expect, beforeAll } from "vitest";
import { bootstrapTestDb } from "./_helpers/bootstrap-test-db";
import { createSqliteAgentService } from "@open-managed-agents/agents-store";
import { createSqliteVaultService } from "@open-managed-agents/vaults-store";
import { createSqliteCredentialService } from "@open-managed-agents/credentials-store";
import { createSqliteSessionService } from "@open-managed-agents/sessions-store";
import {
  buildIntegrationsGatewayRoutes,
} from "@open-managed-agents/http-routes";
import { NodeInstallBridge, buildNodeProvidersForRequest } from "../src/lib/node-install-bridge.js";

const SECRET = "test-platform-root-secret-padded-to-thirtytwo";
const TENANT = "tn_smoke";
const USER = "usr_smoke";
const testDbCleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of testDbCleanups) cleanup();
  testDbCleanups.clear();
});

async function bootstrap() {
  const { sql, db, cleanup } = await bootstrapTestDb();
  testDbCleanups.add(cleanup);
  await sql
    .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
    .bind(TENANT, "Smoke", Date.now(), Date.now())
    .run();
  await sql
    .prepare(`INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
    .bind(USER, TENANT, Date.now())
    .run();

  const agents = createSqliteAgentService({ db });
  const vaults = createSqliteVaultService({ db });
  const credentials = createSqliteCredentialService({ db });
  const sessions = createSqliteSessionService({ db });

  const bridge = new NodeInstallBridge({
    sql,
    db,
    platformRootSecret: SECRET,
    gatewayOrigin: "https://gateway.test",
    vaults,
    credentials,
    sessions,
    agents,
    resolveTenantId: async (uid) => (uid === USER ? TENANT : null),
  });
  return { sql, db, agents, vaults, credentials, sessions, bridge };
}

describe("NodeInstallBridge", () => {
  it("lookupLinearCredentialForSession resolves cred from session metadata", async () => {
    const { sql, agents, vaults, credentials, sessions, bridge } = await bootstrap();
    // Seed an agent + linear installation + publication + bound session.
    const agentRow = await createTestAgent(sql, agents);

    const containers = bridge.buildContainers();
    const inst = await containers.linear.installations.insert({
      tenantId: TENANT,
      userId: USER,
      providerId: "linear",
      workspaceId: "ws_smoke",
      workspaceName: "Smoke Workspace",
      installKind: "shared",
      appId: null,
      accessToken: "lin_oauth_smoke_access",
      refreshToken: "lin_oauth_smoke_refresh",
      scopes: ["read", "write"],
      botUserId: "u_bot_smoke",
    });
    const pub = await containers.linear.publications.insert({
      tenantId: TENANT,
      userId: USER,
      agentId: agentRow.id,
      installationId: inst.id,
      environmentId: "env-local-runtime",
      mode: "full",
      status: "live",
      persona: { name: "Smoke Bot", avatarUrl: null },
      capabilities: new Set(["mention_response"]),
      sessionGranularity: "per_issue",
    });
    const vault = await vaults.create({ tenantId: TENANT, name: "Linear · Smoke" });
    await credentials.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "Linear OAuth bearer",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://mcp.linear.app/mcp",
        token: "lin_oauth_smoke_access",
        provider: "linear",
      },
    });

    // Create a session whose metadata.linear.publicationId points at the pub.
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: agentRow.id,
      environmentId: "env-local-runtime",
      title: "smoke",
      vaultIds: [vault.id],
      agentSnapshot: agentRow as never,
      environmentSnapshot: { id: "env-local-runtime", runtime: "local", sandbox_template: null } as never,
      metadata: {
        linear: {
          publicationId: pub.id,
          mcp_token: "session-bearer-uuid",
          issueId: "issue-abc",
        },
      } as never,
    });

    const result = await bridge.lookupLinearCredentialForSession({
      sessionId: session.id,
      bearerToken: "session-bearer-uuid",
    });
    expect(result.publicationId).toBe(pub.id);
    expect(result.installationId).toBe(inst.id);
    expect(result.userId).toBe(USER);
    expect(result.issueId).toBe("issue-abc");
    expect(result.accessToken).toBe("lin_oauth_smoke_access");

    // Bad token rejects.
    await expect(
      bridge.lookupLinearCredentialForSession({
        sessionId: session.id,
        bearerToken: "wrong",
      }),
    ).rejects.toThrow(/invalid token/);
  });

  it("Linear MCP linear_graphql tool round-trips via mocked Linear API", async () => {
    const { sql, agents, vaults, credentials, sessions, bridge } = await bootstrap();
    const agentRow = await createTestAgent(sql, agents);
    const containers = bridge.buildContainers();
    const inst = await containers.linear.installations.insert({
      tenantId: TENANT,
      userId: USER,
      providerId: "linear",
      workspaceId: "ws_mcp",
      workspaceName: "MCP Smoke",
      installKind: "shared",
      appId: null,
      accessToken: "lin_oauth_mcp_access",
      refreshToken: "lin_oauth_mcp_refresh",
      scopes: ["read"],
      botUserId: "u_mcp",
    });
    const pub = await containers.linear.publications.insert({
      tenantId: TENANT,
      userId: USER,
      agentId: agentRow.id,
      installationId: inst.id,
      environmentId: "env-local-runtime",
      mode: "full",
      status: "live",
      persona: { name: "MCP Bot", avatarUrl: null },
      capabilities: new Set(["mention_response"]),
      sessionGranularity: "per_issue",
    });
    const vault = await vaults.create({ tenantId: TENANT, name: "Linear MCP" });
    await credentials.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "MCP",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://mcp.linear.app/mcp",
        token: "lin_oauth_mcp_access",
      },
    });
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: agentRow.id,
      environmentId: "env-local-runtime",
      title: "mcp",
      vaultIds: [vault.id],
      agentSnapshot: agentRow as never,
      environmentSnapshot: { id: "env-local-runtime", runtime: "local", sandbox_template: null } as never,
      metadata: { linear: { publicationId: pub.id, mcp_token: "mcp-bearer", issueId: null } } as never,
    });

    // Mock global fetch — return a canned Linear GraphQL response.
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (u === "https://api.linear.app/graphql") {
        // Verify the bearer header.
        const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
        if (auth !== "Bearer lin_oauth_mcp_access") {
          return new Response(JSON.stringify({ errors: [{ message: "bad auth" }] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ data: { viewer: { id: "u_mcp", name: "MCP Bot" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;

    try {
      const gateway = buildIntegrationsGatewayRoutes({
        installBridge: bridge,
        jwt: containers.linear.jwt,
        webhooks: {},
        internalSecret: null,
      });
      const res = await gateway.fetch(
        new Request(`http://test/linear/mcp/${session.id}`, {
          method: "POST",
          headers: {
            authorization: "Bearer mcp-bearer",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "linear_graphql", arguments: { query: "query { viewer { id } }" } },
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
      const text = body.result?.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.data.viewer.id).toBe("u_mcp");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refreshGithubVault mints a fresh token via mocked GitHub", async () => {
    const { sql, vaults, credentials, bridge } = await bootstrap();
    void sql;
    const containers = bridge.buildContainers();
    // Seed a github app + installation + bound vault.
    const ghApp = await containers.github.githubApps.insert({
      tenantId: TENANT,
      publicationId: null,
      appId: "12345",
      appSlug: "smoke-app",
      botLogin: "smoke-app[bot]",
      clientId: null,
      clientSecret: null,
      webhookSecret: "ghw_smoke",
      privateKey: TEST_PRIVATE_KEY,
    });
    const inst = await containers.github.installations.insert({
      tenantId: TENANT,
      userId: USER,
      providerId: "github",
      workspaceId: "987",
      workspaceName: "smoke-org",
      installKind: "dedicated",
      appId: ghApp.id,
      accessToken: "ghs_old_token",
      refreshToken: null,
      scopes: ["repo"],
      botUserId: "smoke-app[bot]",
    });
    const vault = await vaults.create({ tenantId: TENANT, name: "GitHub vault" });
    await containers.github.installations.setVaultId(inst.id, vault.id);
    await credentials.create({
      tenantId: TENANT,
      vaultId: vault.id,
      displayName: "GitHub bearer",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://api.githubcopilot.com/mcp/",
        token: "ghs_old_token",
        provider: "github",
      },
    });

    // Mock fetch — return a fresh installation token from GitHub.
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_FRESHTOKEN12345",
            expires_at: "2099-01-01T00:00:00Z",
            permissions: { contents: "write" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;

    try {
      const result = await bridge.refreshGithubVault({ userId: USER, vaultId: vault.id });
      expect(result.token).toBe("ghs_FRESHTOKEN12345");
      // Verify the rotation happened: list creds and check the static_bearer
      // token was updated.
      const list = await credentials.list({ tenantId: TENANT, vaultId: vault.id });
      const updated = list.find((c) => c.auth?.type === "static_bearer");
      expect(updated?.auth?.token).toBe("ghs_FRESHTOKEN12345");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("buildNodeProvidersForRequest exposes the same providers that handle webhooks", async () => {
    const { bridge } = await bootstrap();
    const providers = buildNodeProvidersForRequest(bridge, "https://gateway.test");
    expect(providers.linear.id).toBe("linear");
    expect(providers.github.id).toBe("github");
    expect(providers.slack.id).toBe("slack");
  });

  it("InProcessSessionCreator.resume forwards webhook → user.message via appendUserEvent", async () => {
    // Wire the bridge with an appendUserEvent callback that captures the
    // event the way NodeSessionRouter.appendEvent would on prod.
    const { sql, db, cleanup } = await bootstrapTestDb();
    testDbCleanups.add(cleanup);
    await sql
      .prepare(`INSERT INTO "tenant" (id, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?)`)
      .bind(TENANT, "Smoke", Date.now(), Date.now())
      .run();
    await sql
      .prepare(`INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
      .bind(USER, TENANT, Date.now())
      .run();

    const agents = createSqliteAgentService({ db });
    const vaults = createSqliteVaultService({ db });
    const credentials = createSqliteCredentialService({ db });
    const sessions = createSqliteSessionService({ db });

    const captured: Array<{ sid: string; tenantId: string; agentId: string; event: unknown }> = [];
    const bridge = new NodeInstallBridge({
      sql,
      db,
      platformRootSecret: SECRET,
      gatewayOrigin: "https://gateway.test",
      vaults,
      credentials,
      sessions,
      agents,
      resolveTenantId: async (uid) => (uid === USER ? TENANT : null),
      appendUserEvent: async (sid, tenantId, agentId, event) => {
        captured.push({ sid, tenantId, agentId, event });
      },
    });
    const containers = bridge.buildContainers();

    // Seed an agent + linear pub + bound session.
    const agentRow = await agents.create({
      tenantId: TENANT,
      input: { name: "Resume Bot", model: "claude-haiku-4-5-20251001", system: "you are smoke" },
    });
    const inst = await containers.linear.installations.insert({
      tenantId: TENANT,
      userId: USER,
      providerId: "linear",
      workspaceId: "ws_resume",
      workspaceName: "Resume",
      installKind: "shared",
      appId: null,
      accessToken: "lin_oauth_resume",
      refreshToken: null,
      scopes: ["read"],
      botUserId: "u_bot_resume",
    });
    const pub = await containers.linear.publications.insert({
      tenantId: TENANT,
      userId: USER,
      agentId: agentRow.id,
      installationId: inst.id,
      environmentId: "env-local-runtime",
      mode: "full",
      status: "live",
      persona: { name: "Resume", avatarUrl: null },
      capabilities: new Set(["mention_response"]),
      sessionGranularity: "per_issue",
    });
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: agentRow.id,
      environmentId: "env-local-runtime",
      title: "resume-smoke",
      vaultIds: [],
      agentSnapshot: agentRow as never,
      environmentSnapshot: { id: "env-local-runtime", runtime: "local", sandbox_template: null } as never,
      metadata: { linear: { publicationId: pub.id } } as never,
    });

    // Create the in-process session creator (mirrors what providers see
    // through their Container).
    const linearContainer = containers.linear;
    await linearContainer.sessions.resume(USER, session.id, {
      type: "user.message",
      content: [{ type: "text", text: "# Linear comment activity\n> hi from human" }],
      metadata: { linear: { publicationId: pub.id } },
    });

    expect(captured.length).toBe(1);
    expect(captured[0].sid).toBe(session.id);
    expect(captured[0].tenantId).toBe(TENANT);
    expect(captured[0].agentId).toBe(agentRow.id);
    const ev = captured[0].event as { type: string; content: Array<{ text: string }> };
    expect(ev.type).toBe("user.message");
    expect(ev.content[0].text).toContain("# Linear comment activity");

    // Missing session → throws (webhook handler will swallow + log).
    await expect(
      linearContainer.sessions.resume(USER, "ses_does_not_exist", {
        type: "user.message",
        content: [{ type: "text", text: "x" }],
      }),
    ).rejects.toThrow(/session_not_found/);
  });

  it("startInstallation linear/create-publication returns a publication shell envelope (publication-first)", async () => {
    const { bridge } = await bootstrap();
    const result = await bridge.startInstallation({
      provider: "linear",
      mode: "create-publication",
      body: {
        userId: USER,
        agentId: "agt_dummy",
        environmentId: "env-local-runtime",
        personaName: "Bot",
        personaAvatarUrl: null,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(result.status).toBe(200);
    expect(typeof (result.body as { publication_id?: string }).publication_id).toBe("string");
    expect(typeof (result.body as { callback_url?: string }).callback_url).toBe("string");
    expect(typeof (result.body as { webhook_url?: string }).webhook_url).toBe("string");
    expect((result.body as { suggested_app_name?: string }).suggested_app_name).toBe("Bot");
    const pubId = (result.body as { publication_id: string }).publication_id;
    expect((result.body as { callback_url: string }).callback_url).toContain(
      `/linear/oauth/pub/${pubId}/callback`,
    );
    expect((result.body as { webhook_url: string }).webhook_url).toContain(
      `/linear/webhook/pub/${pubId}`,
    );
  });

  it("startInstallation linear/start-a1 returns 410 — legacy flow removed", async () => {
    const { bridge } = await bootstrap();
    const result = await bridge.startInstallation({
      provider: "linear",
      mode: "start-a1",
      body: {
        userId: USER,
        agentId: "agt_dummy",
        environmentId: "env-local-runtime",
        personaName: "Bot",
        personaAvatarUrl: null,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(result.status).toBe(410);
    expect((result.body as { error?: string }).error).toBe("linear_legacy_install_removed");
  });

  it("startInstallation linear/credentials returns 410 — legacy flow removed", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "linear",
      mode: "credentials",
      body: {
        formToken: "not-a-real-jwt",
        clientId: "id",
        clientSecret: "sec",
        webhookSecret: "lin_wh_x",
      },
    });
    expect(r.status).toBe(410);
    expect((r.body as { error?: string }).error).toBe("linear_legacy_install_removed");
  });

  it("startInstallation github/start-a1 returns a credentials_form envelope matching CF", async () => {
    const { bridge } = await bootstrap();
    const result = await bridge.startInstallation({
      provider: "github",
      mode: "start-a1",
      body: {
        userId: USER,
        agentId: "agt_dummy",
        environmentId: "env-local-runtime",
        personaName: "GH Bot",
        personaAvatarUrl: null,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(result.status).toBe(200);
    expect(typeof (result.body as { formToken?: string }).formToken).toBe("string");
    expect(typeof (result.body as { setupUrl?: string }).setupUrl).toBe("string");
    expect(typeof (result.body as { webhookUrl?: string }).webhookUrl).toBe("string");
  });

  it("startInstallation slack/handoff-link rejects missing formToken", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "slack",
      mode: "handoff-link",
      body: {},
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toBe("formToken required");
  });

  it("startInstallation linear/personal-token rejects missing patToken with stable error", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "linear",
      mode: "personal-token",
      body: { userId: USER, agentId: "agt", environmentId: "env-local-runtime", personaName: "Bot" },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toMatch(/required/);
  });

  it("startInstallation rejects personal-token for non-linear providers (CF parity)", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "github",
      mode: "personal-token",
      body: {},
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toMatch(/personal-token/);
  });

  it("startInstallation feishu/form-token reissues a fresh formToken for an existing shell (resume)", async () => {
    const { bridge } = await bootstrap();
    // Seed a feishu publication shell via start-a1 (status pending_setup).
    const a1 = await bridge.startInstallation({
      provider: "feishu",
      mode: "start-a1",
      body: {
        userId: USER,
        agentId: "agt_dummy",
        environmentId: "env-local-runtime",
        personaName: "Feishu Bot",
        personaAvatarUrl: null,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(a1.status).toBe(200);
    const pubId = (a1.body as { publicationId: string }).publicationId;

    // Resume: reissue a fresh formToken against the SAME shell — no new row.
    const r = await bridge.startInstallation({
      provider: "feishu",
      mode: "form-token",
      body: {
        publicationId: pubId,
        userId: USER,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(r.status).toBe(200);
    const data = r.body as {
      formToken?: string;
      publicationId?: string;
      requiredFields?: string[];
      optionalFields?: string[];
    };
    expect(typeof data.formToken).toBe("string");
    // Note: we do NOT assert the token differs from a1's — a deterministic
    // HMAC JWT re-signed in the same second with identical claims is
    // byte-identical. What matters is that it's a VALID token carrying the
    // SAME publicationId (resumes the shell, doesn't mint a new one).
    expect(data.publicationId).toBe(pubId); // same shell, not a new one
    expect(decodeJwtPayload(data.formToken!).publicationId).toBe(pubId);
    // encryptKey + verificationToken are optional (HTTP-webhook path only);
    // only appId + appSecret are required. The wizard surfaces both lists.
    expect(data.requiredFields).toEqual(["appId", "appSecret"]);
    expect(data.optionalFields).toEqual(["encryptKey", "verificationToken"]);
  });

  it("startInstallation feishu/form-token rejects missing publicationId/userId", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "feishu",
      mode: "form-token",
      body: { userId: USER },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toMatch(/required/);
  });

  it("startInstallation feishu/form-token maps an unknown publicationId to 400 form_token_failed", async () => {
    const { bridge } = await bootstrap();
    const r = await bridge.startInstallation({
      provider: "feishu",
      mode: "form-token",
      body: {
        publicationId: "pub_does_not_exist",
        userId: USER,
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toBe("form_token_failed");
  });

  it("startInstallation feishu/form-token rejects an owner mismatch (provider defense-in-depth)", async () => {
    const { bridge } = await bootstrap();
    const a1 = await bridge.startInstallation({
      provider: "feishu",
      mode: "start-a1",
      body: {
        userId: USER,
        agentId: "agt_dummy",
        environmentId: "env-local-runtime",
        personaName: "Feishu Bot",
        personaAvatarUrl: null,
        returnUrl: "https://console.example.com/done",
      },
    });
    const pubId = (a1.body as { publicationId: string }).publicationId;
    // The route layer gates ownership; the provider re-validates as
    // defense-in-depth — a mismatched userId surfaces as form_token_failed.
    const r = await bridge.startInstallation({
      provider: "feishu",
      mode: "form-token",
      body: {
        publicationId: pubId,
        userId: "usr_someone_else",
        returnUrl: "https://console.example.com/done",
      },
    });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toBe("form_token_failed");
  });
});

async function createTestAgent(sql: SqlClient, agents: ReturnType<typeof createSqliteAgentService>) {
  void sql;
  const row = await agents.create({
    tenantId: TENANT,
    input: {
      name: "Smoke Agent",
      model: "claude-haiku-4-5-20251001",
      system: "you are smoke",
    },
  });
  return row;
}

/** Decode a JWT's payload segment WITHOUT verifying (test-only). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

// Minimal RSA test private key for mintAppJwt — short enough to embed.
// Generated via openssl genrsa 2048 just for tests; never used in prod.
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDXbCJOQOJmZqe5
NShXIYOlWIyR2tuT/GUNhVYFhq3v/ngvcw2mUfmBV8yTXVZrJV6h2VnHXbQYudUd
LHoirP0zo12xVumrU/rPEfb7ynpW9V83InGtv6XYrGNTwHxxvyHJlxfWQvKqf1c1
N18S/+YvgpNDsQumv+hEeu+I8ddQfedjHcDmmzWftfUQVVVhmvGQdyUg8FWYV4QR
LeWIkSHa70CNORWOwq6m9HOgs3yX9wvAtdC5avZxLLSBJ/X1sk8UVO7cwuwqIJy7
yK/KRLWpmd9Pu4VZ4VHAgM01yZewPm++p6WbOqFLuQrZLWflQ72kkAfikd4ZmJYY
pOAqRxKDAgMBAAECggEACsa1QcHZ12C3i7kBdb4XyxPWCWePVm9MhhtR4NlPCTRZ
wQBhe/2QF6VzAMR8Ec0RVTjI6f8lHL5XbRlqx+L13+27R/g7cgL6YhmUkv4IK6sa
SaJoBQwPQqDw1c+5wvgXAMxhwZUngYltuGRDtlwGZZF4dQfAOaeqjGQCRpUWk2zP
zvRMFR0d/y3JrpDdwfRROTwVXCdqs4zSwz74ek0z+QibsX98iBC5QXTmM/TWiVWZ
KKtVDHkLTOEkjMQVi6n4xhdwVYBekI94WzDh9kgHQHCJZLv/OFlIEXvk9/WmiBQs
XgsGq7Pk2I9uwXuK6V7ZbfhLkvm4y5Itv77oXM59cQKBgQD9FjdHb6e82GuqhGRY
xM0dIfdnhl9CIbBKrSnt7fG2KzsmOu/HMGowtyrNNeI/U9o45Q+cFrgytnyLW2n5
sOnbbLRzfpe7H+Eku1EZpJBJSZiM/rZlBMjmUiI+wRlMnA/Yo9gO3KWY8yL5UgY7
qj++D29hxAmihjUv2OrHr+WiNQKBgQDZ58ZrCh5dYTBg1g59W5JAv7cTROD/dSUd
xyCjAOJBRZNuOlxjCevNdTvU9rPTTInq3eZ8JmIQ77Vx7qS/EItMPvHj5OIaEX6E
EGu24/TDwPjw3M4c9nP7wHXXtFCsmHwNdhSBp+MM6p1ms+HWFlsUWX3gRaH3iRTd
gpNvcUrIVwKBgQCVDe4d0YoT3pRJI7JsIMwdQBJXWyk/oZDl5rFBA76XsNoXmqx0
WTwH9HQdMCCspzTuaiAccIhGLPUeRJOk0gIGkqd/ICrLVHWkBN94oM5qxxIqbsTU
yqI3cIVO4ka2DSHGjV/Q/GO/PG4S1Il5q22rGYopFXKILAk24Eyyk2UY9QKBgQDF
eLQy8vtwy/Mh2N7RmH64R67y1LhiW9c39NqB9Mp2jNvULOSZwuZRfQMWfsl6aJOq
W56CiLJWsNvUcWEWbInlvSWymsqQYdMG9zCD5IwRjUmJWefkbdFttMsRxWITBh+r
xcEyKIRqLZ2CAQ0bNeBEXBIO0PzgdN1+lDS/EahpywKBgQCi9SwEXM1n6axTC1tS
TSZ9zdvD3TPAKj3/4HJYPDh4fLULtHtX2+L9UeUF8EcL3Kqgz+hC0CRPRLELYM07
e43nXM4G2QegVrL1c4u7fVzUhFGXqoY+xiAYa//JDyFxNR9jWavmAiIIGIJ9/+/h
FF9ZEbS8ihFcZAtGzVS/PVo4tg==
-----END PRIVATE KEY-----`;
