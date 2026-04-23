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

/**
 * Walks the provider through start → submit → install_callback so the test
 * has a live publication + linked App row to dispatch against. Returns the
 * appOmaId and publicationId.
 */
async function bootstrapPublication(
  c: FakeContainer,
  provider: GitHubProvider,
  webhookSecret = "wh_secret",
): Promise<{ appOmaId: string; publicationId: string; botLogin: string }> {
  const start = await provider.startInstall({
    userId: "usr_a", agentId: "agt_coder", environmentId: "env_dev", mode: "full",
    persona: { name: "Coder", avatarUrl: null }, returnUrl: "https://console/done",
  });
  if (start.kind !== "step") throw new Error("expected step");

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
      webhookSecret,
    },
  });
  if (submit.kind !== "step") throw new Error("expected step");
  const state = new URL(submit.data.url as string).searchParams.get("state")!;
  const appOmaId = submit.data.appOmaId as string;
  const botLogin = submit.data.botLogin as string;

  c.http.respondWith(
    {
      status: 201, headers: {},
      body: JSON.stringify({
        token: "ghs_install_token",
        expires_at: "2026-04-21T13:00:00Z",
        permissions: { issues: "write" },
        repository_selection: "all",
      }),
    },
    {
      status: 200, headers: {},
      body: JSON.stringify({
        id: 9988776,
        account: { id: 1, login: "acme", type: "Organization" },
        repository_selection: "all",
        app_id: 7654321,
        permissions: { issues: "write" },
        events: ["issues"],
        html_url: "https://github.com/apps/coder-bot",
      }),
    },
  );
  const complete = await provider.continueInstall({
    publicationId: null,
    payload: { kind: "install_callback", appOmaId, installationId: "9988776", state },
  });
  if (complete.kind !== "complete") throw new Error("expected complete");
  return { appOmaId, publicationId: complete.publicationId, botLogin };
}

/** FakeHmacVerifier accepts signatures of the form `expected:<secret>:<body>`. */
function fakeSig(secret: string, body: string): string {
  return `sha256=expected:${secret}:${body}`;
}

describe("GitHubProvider — webhook dispatch", () => {
  let c: FakeContainer;
  let provider: GitHubProvider;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    if (!FAKE_PEM) FAKE_PEM = await generateTestPrivateKeyPem();
  });

  it("rejects when delivery id is missing", async () => {
    const { appOmaId } = await bootstrapPublication(c, provider);
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: appOmaId,
      deliveryId: null,
      headers: {},
      rawBody: "{}",
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe("missing_delivery_id");
  });

  it("rejects when the App row doesn't exist", async () => {
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: "ghapp_does_not_exist",
      deliveryId: "del_x",
      headers: { "x-github-event": "issues", "x-hub-signature-256": fakeSig("wh", "{}") },
      rawBody: "{}",
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe("unknown_app");
  });

  it("rejects when signature is missing or malformed", async () => {
    const { appOmaId } = await bootstrapPublication(c, provider);
    const body = "{}";
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: appOmaId,
      deliveryId: "del_1",
      headers: { "x-github-event": "issues" },
      rawBody: body,
    });
    expect(out.reason).toBe("missing_or_malformed_signature");
  });

  it("rejects when signature doesn't match (FakeHmacVerifier requires expected:<secret>:<body>)", async () => {
    const { appOmaId } = await bootstrapPublication(c, provider, "wh_secret");
    const body = "{}";
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: appOmaId,
      deliveryId: "del_1",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=garbage",
      },
      rawBody: body,
    });
    expect(out.reason).toBe("invalid_signature");
  });

  it("dispatches issue_assigned to a fresh session, recording app+publication+session on the event", async () => {
    const { appOmaId, botLogin, publicationId } = await bootstrapPublication(
      c, provider, "wh_secret",
    );
    const body = JSON.stringify({
      action: "assigned",
      installation: { id: 9988776 },
      repository: { id: 1, name: "api", full_name: "acme/api" },
      sender: { id: 99, login: "alice" },
      issue: {
        id: 100, number: 142, title: "Auth bug", state: "open",
        assignees: [{ id: 1, login: botLogin }],
        labels: [{ name: "bug" }],
        html_url: "https://github.com/acme/api/issues/142",
      },
    });
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: appOmaId,
      deliveryId: "del_assigned_1",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": fakeSig("wh_secret", body),
      },
      rawBody: body,
    });
    expect(out.handled).toBe(true);
    expect(out.publicationId).toBe(publicationId);
    expect(out.sessionId).toBeTruthy();

    // SessionCreator received our event with proper metadata.
    expect(c.sessions.created).toHaveLength(1);
    const session = c.sessions.created[0];
    expect(session.userId).toBe("usr_a");
    expect(session.agentId).toBe("agt_coder");
    expect(session.environmentId).toBe("env_dev");
    expect(session.mcpServers).toEqual([
      { name: "github", url: DEFAULT_GITHUB_MCP_URL },
    ]);
    expect(session.metadata).toMatchObject({
      github: { issueKey: "acme/api#142" },
    });
    const text = (session.initialEvent.content as Array<{ text?: string }>)[0]?.text;
    expect(text).toContain("acme/api#142");
    expect(text).toContain("Auth bug");
    expect(text).toContain("@alice");

    // webhook_events row carries the trace.
    const wh = c.webhookEvents.rows.get("del_assigned_1");
    expect(wh?.publicationId).toBe(publicationId);
    expect(wh?.sessionId).toBe(out.sessionId);
  });

  it("a second comment on the same issue resumes the existing session (per_issue)", async () => {
    const { appOmaId, botLogin } = await bootstrapPublication(c, provider, "wh_secret");

    // First webhook → opens session.
    const body1 = JSON.stringify({
      action: "assigned",
      installation: { id: 9988776 },
      repository: { id: 1, name: "api", full_name: "acme/api" },
      sender: { id: 99, login: "alice" },
      issue: {
        id: 100, number: 142, title: "Auth bug", state: "open",
        assignees: [{ id: 1, login: botLogin }],
      },
    });
    const out1 = await provider.handleWebhook({
      providerId: "github", installationId: appOmaId, deliveryId: "del_a",
      headers: { "x-github-event": "issues", "x-hub-signature-256": fakeSig("wh_secret", body1) },
      rawBody: body1,
    });
    expect(out1.handled).toBe(true);
    const sessionId = out1.sessionId!;

    // Second webhook on the same issue (a comment) → resume.
    const body2 = JSON.stringify({
      action: "created",
      installation: { id: 9988776 },
      repository: { id: 1, name: "api", full_name: "acme/api" },
      sender: { id: 99, login: "alice" },
      issue: { id: 100, number: 142, title: "Auth bug", state: "open" },
      comment: { id: 200, body: `@${botLogin} any progress?` },
    });
    const out2 = await provider.handleWebhook({
      providerId: "github", installationId: appOmaId, deliveryId: "del_b",
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": fakeSig("wh_secret", body2) },
      rawBody: body2,
    });
    expect(out2.handled).toBe(true);
    expect(out2.sessionId).toBe(sessionId);

    // SessionCreator: 1 created + 1 resumed.
    expect(c.sessions.created).toHaveLength(1);
    expect(c.sessions.resumed).toHaveLength(1);
    expect(c.sessions.resumed[0].sessionId).toBe(sessionId);
  });

  it("duplicate delivery id is dropped (idempotency)", async () => {
    const { appOmaId, botLogin } = await bootstrapPublication(c, provider, "wh_secret");
    const body = JSON.stringify({
      action: "assigned",
      installation: { id: 9988776 },
      repository: { id: 1, name: "api", full_name: "acme/api" },
      sender: { id: 99, login: "alice" },
      issue: {
        id: 100, number: 1, title: "T", state: "open",
        assignees: [{ id: 1, login: botLogin }],
      },
    });
    const opts = {
      providerId: "github" as const,
      installationId: appOmaId,
      deliveryId: "del_dupe",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": fakeSig("wh_secret", body),
      },
      rawBody: body,
    };
    const first = await provider.handleWebhook(opts);
    const second = await provider.handleWebhook(opts);
    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(second.reason).toBe("duplicate_delivery");
    expect(c.sessions.created).toHaveLength(1);
  });

  it("ignores events that map to kind=null (e.g. push) but still records for observability", async () => {
    const { appOmaId } = await bootstrapPublication(c, provider, "wh_secret");
    const body = JSON.stringify({
      installation: { id: 9988776 },
      repository: { id: 1, name: "api", full_name: "acme/api" },
      sender: { id: 99, login: "alice" },
    });
    const out = await provider.handleWebhook({
      providerId: "github",
      installationId: appOmaId,
      deliveryId: "del_push",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": fakeSig("wh_secret", body),
      },
      rawBody: body,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe("ignored_event_kind");
    // Still recorded in webhook_events for traceability.
    expect(c.webhookEvents.rows.has("del_push")).toBe(true);
    // No session opened.
    expect(c.sessions.created).toHaveLength(0);
  });
});
