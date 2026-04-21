import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    gatewayOrigin: "https://gw",
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

describe("LinearProvider — A1 (full identity) install flow", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  beforeEach(() => {
    c = buildFakeContainer();
    provider = makeProvider(c);
  });

  it("startInstall(full) returns credentials_form with final URLs (containing the appId minted in step 1) + form token", async () => {
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
    // Step 1 now mints the appId so the URLs it shows are the same ones
    // step 2 will return — no more `<APP_ID>` placeholder reconciliation.
    expect(result.data.callbackUrl as string).toMatch(
      /^https:\/\/gw\/linear\/oauth\/app\/[^/]+\/callback$/,
    );
    expect(result.data.webhookUrl as string).toMatch(
      /^https:\/\/gw\/linear\/webhook\/app\/[^/]+$/,
    );
    expect(result.data.callbackUrl).not.toContain("<APP_ID>");
    expect(result.data.webhookUrl).not.toContain("<APP_ID>");
    expect(result.data.webhookSecret).toBeTruthy();
  });

  it("submit_credentials persists App keyed on the appId from step 1 and returns install URL with the same id", async () => {
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
    // The appId in step-1 URLs must equal the appId step 2 hands back —
    // that's the whole point of generating it upfront.
    const startCallbackUrl = start.data.callbackUrl as string;
    const startAppId = startCallbackUrl.match(/\/app\/([^/]+)\/callback$/)?.[1];
    expect(startAppId).toBeTruthy();

    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        clientId: "user_app_id",
        clientSecret: "user_app_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    expect(submit.step).toBe("install_link");

    const appId = submit.data.appId as string;
    expect(appId).toBe(startAppId);
    const installUrl = new URL(submit.data.url as string);
    expect(installUrl.origin + installUrl.pathname).toBe("https://linear.app/oauth/authorize");
    expect(installUrl.searchParams.get("client_id")).toBe("user_app_id");
    expect(installUrl.searchParams.get("redirect_uri")).toContain(`/linear/oauth/app/${appId}/callback`);

    // App row exists with null publication_id
    const app = await c.apps.get(appId);
    expect(app).toBeTruthy();
    expect(app?.publicationId).toBeNull();
    expect(app?.clientId).toBe("user_app_id");

    // Webhook secret is stored encrypted; we can read it back decrypted.
    const wh = await c.apps.getWebhookSecret(appId);
    expect(wh).toBeTruthy();
    expect(wh).toBe(start.data.webhookSecret); // matches what we showed the user
  });

  it("OAuth callback completes install, links App↔Publication, creates vault", async () => {
    // Step 1+2: get an install URL with a state JWT we can replay.
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
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const installUrl = new URL(submit.data.url as string);
    const state = installUrl.searchParams.get("state")!;
    const appId = submit.data.appId as string;

    // Step 3: simulate Linear redirecting back with code.
    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: "lin_at_a1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read,write,app:assignable,app:mentionable",
        }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            viewer: { id: "linbot_a1", name: "Coder" },
            organization: { id: "org_acme", name: "Acme", urlKey: "acme" },
          },
        }),
      },
    );

    const complete = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_dedicated", appId, code: "AUTH_CODE", state },
    });
    expect(complete.kind).toBe("complete");

    // Side effects
    if (complete.kind !== "complete") return;
    const pub = await c.publications.get(complete.publicationId);
    expect(pub).toBeTruthy();
    expect(pub?.mode).toBe("full");

    const installs = await c.installations.listByUser("usr_a", "linear");
    expect(installs).toHaveLength(1);
    expect(installs[0].installKind).toBe("dedicated");
    expect(installs[0].appId).toBe(appId);
    expect(installs[0].vaultId).toBeTruthy();

    // App row's publication_id is now set
    const app = await c.apps.get(appId);
    expect(app?.publicationId).toBe(complete.publicationId);

    // Vault credential created for outbound injection
    expect(c.vaults.created).toHaveLength(1);
    expect(c.vaults.created[0].mcpServerUrl).toBe("https://mcp.linear.app/mcp");
    expect(c.vaults.created[0].bearerToken).toBe("lin_at_a1");
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
    if (handoff.kind !== "step" || handoff.step !== "install_link") {
      throw new Error("expected install_link step");
    }
    const url = handoff.data.url as string;
    expect(url).toContain("/linear-setup/");
    expect(handoff.data.expiresInDays).toBe(7);

    // The new URL's token should still verify (it's a fresh JWT signed by us).
    const token = url.split("/linear-setup/")[1];
    const verified = await c.jwt.verify<{ kind: string; userId: string }>(token);
    expect(verified.kind).toBe("linear.a1.form");
    expect(verified.userId).toBe("usr_a");
  });

  it("handoff_link rejects an invalid formToken", async () => {
    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: { kind: "handoff_link", formToken: "bogus-token" },
      }),
    ).rejects.toThrow();
  });
});
