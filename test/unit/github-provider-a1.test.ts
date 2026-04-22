import { describe, it, expect, beforeEach } from "vitest";
import { GitHubProvider } from "../../packages/github/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import {
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "../../packages/github/src/config";
import { generateTestPrivateKeyPem } from "./github-test-helpers";

let FAKE_PEM: string;

function makeProvider(c: FakeContainer): GitHubProvider {
  return new GitHubProvider(c, {
    gatewayOrigin: "https://gw",
    defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
    mcpServerUrl: DEFAULT_GITHUB_MCP_URL,
  });
}

describe("GitHubProvider — A1 (per-agent App) install flow", () => {
  let c: FakeContainer;
  let provider: GitHubProvider;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    if (!FAKE_PEM) FAKE_PEM = await generateTestPrivateKeyPem();
  });

  it("startInstall(full) returns credentials_form with stable per-app setup + webhook URLs", async () => {
    const result = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.step).toBe("credentials_form");
    const data = result.data;
    expect(data.formToken).toBeTruthy();
    expect(data.appOmaId).toBeTruthy();
    expect(data.suggestedAppName).toBe("Coder");
    expect(data.setupUrl as string).toMatch(
      /^https:\/\/gw\/github\/install\/app\/[^/]+\/callback$/,
    );
    expect(data.webhookUrl as string).toMatch(
      /^https:\/\/gw\/github\/webhook\/app\/[^/]+$/,
    );
    expect(data.recommendedPermissions).toMatchObject({
      issues: "write",
      pull_requests: "write",
    });
    expect(data.recommendedSubscriptions).toEqual(
      expect.arrayContaining(["issues", "pull_request"]),
    );
  });

  it("submit_credentials verifies App via GET /app, persists credentials, returns install URL", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const formToken = start.data.formToken as string;
    const appOmaId = start.data.appOmaId as string;

    // Mock GitHub's `GET /app` reply — the provider uses this to discover
    // the App's slug + bot login (which we then write to github_apps).
    c.http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({
        id: 7654321,
        slug: "coder-bot",
        name: "Coder",
      }),
    });

    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        appId: "7654321",
        privateKey: FAKE_PEM,
        webhookSecret: "wh_random_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    expect(submit.step).toBe("install_link");
    expect(submit.data.appOmaId).toBe(appOmaId);
    expect(submit.data.appSlug).toBe("coder-bot");
    expect(submit.data.botLogin).toBe("coder-bot[bot]");

    const installUrl = new URL(submit.data.url as string);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://github.com/apps/coder-bot/installations/new",
    );
    expect(installUrl.searchParams.get("state")).toBeTruthy();

    const app = await c.githubApps.get(appOmaId);
    expect(app).toBeTruthy();
    expect(app?.publicationId).toBeNull();
    expect(app?.appId).toBe("7654321");
    expect(app?.appSlug).toBe("coder-bot");
    expect(app?.botLogin).toBe("coder-bot[bot]");

    expect(await c.githubApps.getWebhookSecret(appOmaId)).toBe("wh_random_secret");
    expect(await c.githubApps.getPrivateKey(appOmaId)).toBe(FAKE_PEM);
  });

  it("submit_credentials rejects when GET /app returns a different appId than what was pasted", async () => {
    const start = await provider.startInstall({
      userId: "u", agentId: "a", environmentId: "e", mode: "full",
      persona: { name: "X", avatarUrl: null }, returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error();

    c.http.respondWith({
      status: 200, headers: {},
      body: JSON.stringify({ id: 9999999, slug: "x", name: "X" }),
    });

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: {
          kind: "submit_credentials",
          formToken: start.data.formToken as string,
          appId: "1234567", // doesn't match what GitHub returned
          privateKey: FAKE_PEM,
          webhookSecret: "wh",
        },
      }),
    ).rejects.toThrow(/appId mismatch/);
  });

  it("install_callback completes install: mints token, creates vault + publication, links App", async () => {
    const start = await provider.startInstall({
      userId: "usr_a", agentId: "agt_coder", environmentId: "env_dev", mode: "full",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error();

    // GET /app for submit_credentials.
    c.http.respondWith({
      status: 200, headers: {},
      body: JSON.stringify({ id: 7654321, slug: "coder-bot", name: "Coder" }),
    });
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        appId: "7654321",
        privateKey: FAKE_PEM,
        webhookSecret: "wh_secret",
      },
    });
    if (submit.kind !== "step") throw new Error();
    const installUrl = new URL(submit.data.url as string);
    const state = installUrl.searchParams.get("state")!;
    const appOmaId = submit.data.appOmaId as string;

    // Two HTTP calls during install completion:
    //   1. POST /app/installations/{id}/access_tokens → installation token
    //   2. GET  /app/installations/{id} → install detail
    c.http.respondWith(
      {
        status: 201, headers: {},
        body: JSON.stringify({
          token: "ghs_install_token_xyz",
          expires_at: "2026-04-21T13:00:00Z",
          permissions: { issues: "write", pull_requests: "write" },
          repository_selection: "all",
        }),
      },
      {
        status: 200, headers: {},
        body: JSON.stringify({
          id: 9988776,
          account: { id: 1, login: "acme", type: "Organization", avatar_url: "https://av/x" },
          repository_selection: "all",
          app_id: 7654321,
          permissions: { issues: "write", pull_requests: "write" },
          events: ["issues", "pull_request"],
          html_url: "https://github.com/apps/coder-bot",
        }),
      },
    );

    const complete = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "install_callback",
        appOmaId,
        installationId: "9988776",
        state,
      },
    });
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") return;

    const pub = await c.publications.get(complete.publicationId);
    expect(pub).toBeTruthy();
    expect(pub?.userId).toBe("usr_a");
    expect(pub?.agentId).toBe("agt_coder");
    expect(pub?.environmentId).toBe("env_dev");
    expect(pub?.persona).toEqual({ name: "Coder", avatarUrl: "https://avatar/c.png" });
    expect(pub?.status).toBe("live");
    expect(pub?.sessionGranularity).toBe("per_issue");
    // Default capabilities applied.
    expect(pub?.capabilities.has("issue.read")).toBe(true);
    expect(pub?.capabilities.has("pr.create")).toBe(true);
    // Destructive caps NOT in default set.
    expect(pub?.capabilities.has("pr.merge")).toBe(false);

    // Installation row carries the token + workspace info.
    const installations = await c.installations.listByUser("usr_a", "github");
    expect(installations).toHaveLength(1);
    const inst = installations[0];
    expect(inst.workspaceId).toBe("9988776");
    expect(inst.workspaceName).toBe("acme");
    expect(inst.botUserId).toBe("coder-bot[bot]");
    expect(inst.installKind).toBe("dedicated");
    expect(inst.appId).toBe(appOmaId);

    // Vault was created with the installation token + GitHub MCP URL.
    expect(c.vaults.created).toHaveLength(1);
    const vault = c.vaults.created[0];
    expect(vault.bearerToken).toBe("ghs_install_token_xyz");
    expect(vault.mcpServerUrl).toBe(DEFAULT_GITHUB_MCP_URL);
    expect(vault.userId).toBe("usr_a");
    expect(vault.provider).toBe("github");

    // Same token also stashed as a command_secret for sandbox `gh`/`git`.
    expect(c.vaults.commandSecrets).toHaveLength(1);
    const cmdSec = c.vaults.commandSecrets[0];
    expect(cmdSec.token).toBe("ghs_install_token_xyz");
    expect(cmdSec.envVar).toBe("GITHUB_TOKEN");
    expect(cmdSec.commandPrefixes).toEqual(["gh", "git"]);
    expect(cmdSec.provider).toBe("github");
    expect(cmdSec.vaultId).toBe(vault ? "vlt_1" : null); // attached to same vault

    // App row's publicationId is now linked.
    const app = await c.githubApps.get(appOmaId);
    expect(app?.publicationId).toBe(complete.publicationId);
  });

  it("install_callback rejects when state JWT is for a different appOmaId", async () => {
    const start = await provider.startInstall({
      userId: "u", agentId: "a", environmentId: "e", mode: "full",
      persona: { name: "X", avatarUrl: null }, returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error();
    c.http.respondWith({
      status: 200, headers: {},
      body: JSON.stringify({ id: 1, slug: "x", name: "X" }),
    });
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        appId: "1",
        privateKey: FAKE_PEM,
        webhookSecret: "wh",
      },
    });
    if (submit.kind !== "step") throw new Error();
    const state = new URL(submit.data.url as string).searchParams.get("state")!;

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: {
          kind: "install_callback",
          appOmaId: "different_oma_id",
          installationId: "111",
          state,
        },
      }),
    ).rejects.toThrow(/appOmaId mismatch/);
  });

  it("handoff_link returns a 7-day shareable URL pointing at /github-setup/<token>", async () => {
    const start = await provider.startInstall({
      userId: "u", agentId: "a", environmentId: "e", mode: "full",
      persona: { name: "X", avatarUrl: null }, returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error();
    const handoff = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "handoff_link",
        formToken: start.data.formToken as string,
      },
    });
    if (handoff.kind !== "step") throw new Error();
    expect(handoff.step).toBe("install_link");
    expect(handoff.data.url as string).toMatch(/^https:\/\/gw\/github-setup\//);
    expect(handoff.data.expiresInDays).toBe(7);
  });

  it("manifest flow: prepareManifestForm + manifest_callback persists App and returns install URL", async () => {
    const start = await provider.startInstall({
      userId: "usr_a", agentId: "agt_coder", environmentId: "env_dev", mode: "full",
      persona: { name: "Coder", avatarUrl: null }, returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error();
    const formToken = start.data.formToken as string;
    const appOmaId = start.data.appOmaId as string;

    // Step A: prepare the manifest form. No HTTP — just JWT round-trip.
    const prepared = await provider.prepareManifestForm(formToken);
    expect(prepared.appOmaId).toBe(appOmaId);
    expect(prepared.suggestedAppName).toBe("Coder");
    expect(prepared.manifest.name).toBe("Coder");
    const manifest = prepared.manifest as Record<string, unknown>;
    expect(manifest.redirect_url).toBe("https://gw/github/manifest/callback");
    expect((manifest.hook_attributes as Record<string, unknown>).url).toBe(
      `https://gw/github/webhook/app/${appOmaId}`,
    );
    expect((manifest.default_events as string[])).toContain("issues");
    expect((manifest.default_events as string[])).toContain("pull_request");

    // Step B: simulate GitHub redirecting to our manifest callback. Mock
    // the conversion endpoint response.
    c.http.respondWith({
      status: 201, headers: {},
      body: JSON.stringify({
        id: 7654321,
        slug: "coder-bot",
        name: "Coder",
        client_id: "cid",
        client_secret: "csec",
        webhook_secret: "whsec_from_github",
        pem: FAKE_PEM,
        html_url: "https://github.com/apps/coder-bot",
      }),
    });

    const callback = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "manifest_callback",
        code: "manifest_code_xyz",
        state: prepared.state,
      },
    });
    if (callback.kind !== "step") throw new Error("expected step");
    expect(callback.step).toBe("install_link");
    expect(callback.data.appOmaId).toBe(appOmaId);
    expect(callback.data.appSlug).toBe("coder-bot");
    expect(callback.data.botLogin).toBe("coder-bot[bot]");

    // App row persisted with manifest-supplied credentials.
    const app = await c.githubApps.get(appOmaId);
    expect(app).toBeTruthy();
    expect(app?.appId).toBe("7654321");
    expect(app?.appSlug).toBe("coder-bot");
    expect(await c.githubApps.getWebhookSecret(appOmaId)).toBe("whsec_from_github");
    expect(await c.githubApps.getPrivateKey(appOmaId)).toBe(FAKE_PEM);

    // Install URL points the user at GitHub's install flow with our state.
    const installUrl = new URL(callback.data.url as string);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://github.com/apps/coder-bot/installations/new",
    );
    expect(installUrl.searchParams.get("state")).toBeTruthy();
  });
});
