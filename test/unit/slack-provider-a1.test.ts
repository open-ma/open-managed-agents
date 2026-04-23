import { describe, it, expect, beforeEach } from "vitest";
import { SlackProvider } from "../../packages/slack/src/provider";
import {
  buildFakeSlackContainer,
  makeSlackProvider,
  tokenResponseBody,
  type FakeSlackBundle,
} from "./slack-test-helpers";

describe("SlackProvider — A1 (full identity) install flow", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;

  beforeEach(() => {
    c = buildFakeSlackContainer();
    provider = makeSlackProvider(c);
  });

  it("startInstall returns credentials_form with final URLs minted in step 1", async () => {
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
    expect(result.data.formToken).toBeTruthy();
    expect(result.data.suggestedAppName).toBe("Coder");
    expect(result.data.callbackUrl as string).toMatch(
      /^https:\/\/gw\/slack\/oauth\/app\/[^/]+\/callback$/,
    );
    expect(result.data.webhookUrl as string).toMatch(
      /^https:\/\/gw\/slack\/webhook\/app\/[^/]+$/,
    );
    // Manifest launch URL is pre-baked with the same appId and persona.
    const manifestUrl = result.data.manifestLaunchUrl as string;
    expect(manifestUrl).toMatch(/^https:\/\/api\.slack\.com\/apps\?/);
    const parsedManifest = new URL(manifestUrl);
    expect(parsedManifest.searchParams.get("new_app")).toBe("1");
    const manifest = JSON.parse(parsedManifest.searchParams.get("manifest_json") ?? "");
    expect(manifest.display_information.name).toBe("Coder");
    expect(manifest.oauth_config.redirect_urls[0]).toBe(result.data.callbackUrl);
    expect(manifest.settings.event_subscriptions.request_url).toBe(result.data.webhookUrl);
  });

  it("submit_credentials persists App keyed on the appId from step 1 and returns OAuth URL with both bot + user scopes", async () => {
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
    const startCallbackUrl = start.data.callbackUrl as string;
    const startAppId = startCallbackUrl.match(/\/app\/([^/]+)\/callback$/)?.[1];

    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        clientId: "user_app_id",
        clientSecret: "user_app_secret",
        signingSecret: "slack_signing_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    expect(submit.step).toBe("install_link");
    expect(submit.data.appId).toBe(startAppId);

    const installUrl = new URL(submit.data.url as string);
    expect(installUrl.origin + installUrl.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(installUrl.searchParams.get("client_id")).toBe("user_app_id");
    expect(installUrl.searchParams.get("scope")).toContain("app_mentions:read");
    expect(installUrl.searchParams.get("user_scope")).toContain("search:read.public");

    const app = await c.apps.get(startAppId!);
    expect(app).toBeTruthy();
    expect(app?.publicationId).toBeNull();
    expect(app?.clientId).toBe("user_app_id");

    const wh = await c.apps.getWebhookSecret(startAppId!);
    expect(wh).toBe("slack_signing_secret");
  });

  it("OAuth callback completes install, stores both tokens, creates two vaults, links app↔publication", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "user_app_id",
        clientSecret: "user_app_secret",
        signingSecret: "slack_signing_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const installUrl = new URL(submit.data.url as string);
    const state = installUrl.searchParams.get("state")!;
    const appId = submit.data.appId as string;

    // Slack will respond with: oauth.v2.access (token), then auth.test (sanity check).
    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: tokenResponseBody(),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          ok: true,
          url: "https://acme.slack.com/",
          team: "Acme",
          user: "coder",
          team_id: "T07TEAM",
          user_id: "U07USER",
          bot_id: "B07BOT",
        }),
      },
    );

    const complete = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_dedicated", appId, code: "AUTH_CODE", state },
    });
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") return;

    const pub = await c.publications.get(complete.publicationId);
    expect(pub).toBeTruthy();
    expect(pub?.mode).toBe("full");
    expect(pub?.sessionGranularity).toBe("per_thread");

    const installs = await c.installations.listByUser("usr_a", "slack");
    expect(installs).toHaveLength(1);
    expect(installs[0].installKind).toBe("dedicated");
    expect(installs[0].appId).toBe(appId);
    expect(installs[0].workspaceId).toBe("T07TEAM");
    expect(installs[0].workspaceName).toBe("Acme");

    // User token stashed via the Slack-only setUserToken extension.
    const userToken = await c.installations.getUserToken(installs[0].id);
    expect(userToken).toBe("xoxp-user-test");

    // App row links to publication.
    const app = await c.apps.get(appId);
    expect(app?.publicationId).toBe(complete.publicationId);

    // TWO vaults — one for mcp.slack.com (user xoxp-) + one for slack.com/api (bot xoxb-).
    expect(c.vaults.created).toHaveLength(2);
    const mcpVault = c.vaults.created.find((v) => v.mcpServerUrl === "https://mcp.slack.com/mcp");
    const apiVault = c.vaults.created.find((v) => v.mcpServerUrl === "https://slack.com/api");
    expect(mcpVault).toBeTruthy();
    expect(mcpVault?.bearerToken).toBe("xoxp-user-test");
    expect(apiVault).toBeTruthy();
    expect(apiVault?.bearerToken).toBe("xoxb-bot-test");

    // Both vault ids stored on the installation.
    const inst = await c.installations.get(installs[0].id);
    expect(inst?.vaultId).toBeTruthy(); // primary (xoxp-)
    expect(await c.installations.getBotVaultId(installs[0].id)).toBeTruthy(); // bot (xoxb-)
  });

  it("rejects callback with mismatched appId in state", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "ssec",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const state = new URL(submit.data.url as string).searchParams.get("state")!;

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: {
          kind: "oauth_callback_dedicated",
          appId: "app_wrong",
          code: "C",
          state,
        },
      }),
    ).rejects.toThrow(/appId mismatch|unknown appId/);
  });

  it("handoff_link re-signs the formToken into a 7-day shareable URL", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");

    const handoff = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "handoff_link", formToken: start.data.formToken as string },
    });
    if (handoff.kind !== "step") throw new Error("expected step");
    expect(handoff.step).toBe("install_link");
    expect(handoff.data.url as string).toMatch(/^https:\/\/gw\/slack-setup\//);
    expect(handoff.data.expiresInDays).toBe(7);
  });
});
