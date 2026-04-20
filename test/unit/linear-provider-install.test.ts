import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

const SHARED_APP = {
  clientId: "oma_app_id",
  clientSecret: "oma_app_secret",
  webhookSecret: "oma_app_wh",
};

const GATEWAY_ORIGIN = "https://gw.example";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    sharedApp: SHARED_APP,
    gatewayOrigin: GATEWAY_ORIGIN,
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

describe("LinearProvider — B+ install flow", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  beforeEach(() => {
    c = buildFakeContainer();
    provider = makeProvider(c);
  });

  it("startInstall (quick) returns a Linear authorize redirect", async () => {
    const result = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "quick",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/integrations/linear?ok",
    });
    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.step).toBe("redirect");
    const url = new URL(result.data.url as string);
    expect(url.origin + url.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("oma_app_id");
    expect(url.searchParams.get("actor")).toBe("app");
  });

  it("completes install: token exchange → installation + publication + vault", async () => {
    // First call: startInstall builds the state JWT.
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "quick",
      persona: { name: "Coder", avatarUrl: "https://avatar/coder.png" },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const state = new URL(start.data.url as string).searchParams.get("state")!;

    // Queue the HTTP responses Linear will give us:
    //   1. token exchange
    //   2. ViewerAndOrg query
    c.http.respondWith(
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          access_token: "lin_at",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read,write,app:assignable,app:mentionable",
        }),
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data: {
            viewer: { id: "linbot_1", name: "OpenMA" },
            organization: {
              id: "org_acme",
              name: "Acme Engineering",
              urlKey: "acme",
            },
          },
        }),
      },
    );

    const complete = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback", code: "AUTH_CODE", state },
    });

    expect(complete.kind).toBe("complete");

    // Side effects: installation + publication + vault credential
    const installs = await c.installations.listByUser("usr_a", "linear");
    expect(installs).toHaveLength(1);
    expect(installs[0].workspaceId).toBe("org_acme");
    expect(installs[0].installKind).toBe("shared");
    expect(installs[0].vaultId).toBeTruthy();

    const accessToken = await c.installations.getAccessToken(installs[0].id);
    expect(accessToken).toBe("lin_at");

    if (complete.kind === "complete") {
      const pub = await c.publications.get(complete.publicationId);
      expect(pub).toBeTruthy();
      expect(pub?.persona.name).toBe("Coder");
      expect(pub?.persona.avatarUrl).toBe("https://avatar/coder.png");
      expect(pub?.slashCommand).toBe("coder");
      expect(pub?.isDefaultAgent).toBe(true); // first publication on this install
      expect(pub?.environmentId).toBe("env_dev");
    }

    expect(c.vaults.created).toHaveLength(1);
    expect(c.vaults.created[0].mcpServerUrl).toBe("https://mcp.linear.app/mcp");
    expect(c.vaults.created[0].bearerToken).toBe("lin_at");
  });

  it("second publish on same workspace reuses the install + vault", async () => {
    // Pre-seed an install + vault so we can verify reuse without going through
    // OAuth twice.
    const inst = await c.installations.insert({
      userId: "usr_a",
      providerId: "linear",
      workspaceId: "org_acme",
      workspaceName: "Acme",
      installKind: "shared",
      appId: null,
      accessToken: "lin_at",
      refreshToken: null,
      scopes: ["read", "write"],
      botUserId: "linbot_1",
    });
    await c.installations.setVaultId(inst.id, "vlt_existing");
    // First publication exists → second should not be default.
    await c.publications.insert({
      userId: "usr_a",
      agentId: "agt_first",
      installationId: inst.id,
      environmentId: "env_dev",
      mode: "quick",
      status: "live",
      persona: { name: "Triage", avatarUrl: null },
      slashCommand: "/triage",
      capabilities: new Set(),
      sessionGranularity: "per_issue",
      isDefaultAgent: true,
    });

    // Now run a second OAuth completion for a different agent on same workspace.
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_designer",
      environmentId: "env_dev",
      mode: "quick",
      persona: { name: "Designer", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const state = new URL(start.data.url as string).searchParams.get("state")!;

    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: "lin_at_v2", token_type: "Bearer", expires_in: 1, scope: "read" }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            viewer: { id: "linbot_1", name: "OpenMA" },
            organization: { id: "org_acme", name: "Acme", urlKey: "acme" },
          },
        }),
      },
    );

    await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback", code: "C2", state },
    });

    // Still one install (reused).
    const installs = await c.installations.listByUser("usr_a", "linear");
    expect(installs).toHaveLength(1);
    expect(installs[0].id).toBe(inst.id);

    // Vault not re-created (vaultId was already set).
    expect(c.vaults.created).toHaveLength(0);

    // Two publications now.
    const pubs = await c.publications.listByInstallation(inst.id);
    expect(pubs).toHaveLength(2);
    const designer = pubs.find((p) => p.agentId === "agt_designer");
    expect(designer?.isDefaultAgent).toBe(false);
  });
});
