import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
  type FakeHttpClient,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    gatewayOrigin: "https://gw",
    consoleOrigin: "https://console",
    scopes: [...DEFAULT_LINEAR_SCOPES],
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

/**
 * Push canned Linear GraphQL responses into the FakeHttpClient queue.
 * Each `responses` entry can be a `data` payload (wrapped automatically as
 * `{ data: <payload> }`, status 200) or an explicit { status, body } shape
 * for error cases.
 */
function queueLinearResponses(
  http: FakeHttpClient,
  responses: Array<unknown | { status: number; body: unknown }>,
) {
  for (const r of responses) {
    if (
      typeof r === "object" &&
      r !== null &&
      "status" in r &&
      "body" in r
    ) {
      const cast = r as { status: number; body: unknown };
      http.respondWith({
        status: cast.status,
        headers: { "content-type": "application/json" },
        body: typeof cast.body === "string" ? cast.body : JSON.stringify(cast.body),
      });
    } else {
      http.respondWith({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: r }),
      });
    }
  }
}

describe("LinearProvider — PAT (personal_token) install", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  beforeEach(() => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    // Provide a tenantId for our test user — TenantResolver throws otherwise.
    c.tenants.set("usr_alice", "tnt_acme");
  });

  it("validates PAT via viewer query then persists installation+vault+publication", async () => {
    queueLinearResponses(c.http, [
      // viewer + organization query response
      {
        viewer: { id: "lin_user_alice", name: "Alice" },
        organization: { id: "lin_ws_acme", name: "Acme", urlKey: "acme" },
      },
    ]);

    const result = await provider.installPersonalToken({
      userId: "usr_alice",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      patToken: "lin_api_xyz",
    });

    expect(result.kind).toBe("complete");
    const pub = await c.publications.get(result.publicationId);
    expect(pub).not.toBeNull();
    expect(pub!.userId).toBe("usr_alice");
    expect(pub!.agentId).toBe("agt_coder");
    expect(pub!.status).toBe("live");

    const inst = await c.installations.get(pub!.installationId);
    expect(inst!.installKind).toBe("personal_token");
    expect(inst!.botUserId).toBe("lin_user_alice");
    expect(inst!.appId).toBeNull();
    expect(inst!.vaultId).not.toBeNull();
  });

  it("rejects empty pat token", async () => {
    await expect(
      provider.installPersonalToken({
        userId: "usr_alice",
        agentId: "agt_coder",
        environmentId: "env_dev",
        persona: { name: "Coder", avatarUrl: null },
        patToken: "  ",
      }),
    ).rejects.toThrow(/patToken required/);
  });

  it("rejects duplicate active install for same workspace+kind", async () => {
    queueLinearResponses(c.http, [
      {
        viewer: { id: "lin_user_alice", name: "Alice" },
        organization: { id: "lin_ws_acme", name: "Acme", urlKey: "acme" },
      },
      {
        viewer: { id: "lin_user_alice", name: "Alice" },
        organization: { id: "lin_ws_acme", name: "Acme", urlKey: "acme" },
      },
    ]);

    await provider.installPersonalToken({
      userId: "usr_alice",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      patToken: "lin_api_xyz",
    });
    await expect(
      provider.installPersonalToken({
        userId: "usr_alice",
        agentId: "agt_coder",
        environmentId: "env_dev",
        persona: { name: "Coder", avatarUrl: null },
        patToken: "lin_api_xyz",
      }),
    ).rejects.toThrow(/already has an active personal-token install/);
  });

  it("propagates Linear validation failure", async () => {
    queueLinearResponses(c.http, [
      { status: 401, body: { errors: [{ message: "Authentication failed" }] } },
    ]);

    await expect(
      provider.installPersonalToken({
        userId: "usr_alice",
        agentId: "agt_coder",
        environmentId: "env_dev",
        persona: { name: "Coder", avatarUrl: null },
        patToken: "lin_api_bogus",
      }),
    ).rejects.toThrow(/Linear PAT validation failed/);
  });
});

describe("InMemoryIssueSessionRepo — claim()", () => {
  let c: FakeContainer;

  beforeEach(() => {
    c = buildFakeContainer();
  });

  it("returns true for a fresh slot, false for a concurrent claim", async () => {
    const first = await c.issueSessions.claim({
      tenantId: "tnt_acme",
      publicationId: "pub_1",
      issueId: "iss_1",
      sessionId: "sess_a",
      nowMs: 1000,
    });
    expect(first).toBe(true);
    const second = await c.issueSessions.claim({
      tenantId: "tnt_acme",
      publicationId: "pub_1",
      issueId: "iss_1",
      sessionId: "sess_b",
      nowMs: 1001,
    });
    expect(second).toBe(false);
  });

  it("allows re-claim after an existing slot is no longer active", async () => {
    await c.issueSessions.claim({
      tenantId: "tnt_acme",
      publicationId: "pub_1",
      issueId: "iss_1",
      sessionId: "sess_a",
      nowMs: 1000,
    });
    await c.issueSessions.updateStatus("pub_1", "iss_1", "failed");
    const reclaimed = await c.issueSessions.claim({
      tenantId: "tnt_acme",
      publicationId: "pub_1",
      issueId: "iss_1",
      sessionId: "sess_b",
      nowMs: 2000,
    });
    expect(reclaimed).toBe(true);
    const row = await c.issueSessions.getByIssue("pub_1", "iss_1");
    expect(row?.sessionId).toBe("sess_b");
    expect(row?.status).toBe("active");
  });
});

describe("LinearProvider — runDispatchSweep", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    c.tenants.set("usr_alice", "tnt_acme");

    // Seed an installation + publication so rules have something to point at.
    const inst = await c.installations.insert({
      tenantId: "tnt_acme",
      userId: "usr_alice",
      providerId: "linear",
      workspaceId: "lin_ws_acme",
      workspaceName: "Acme",
      installKind: "dedicated",
      appId: "app_x",
      accessToken: "tok_oauth",
      refreshToken: null,
      scopes: ["read", "write", "app:assignable"],
      botUserId: "lin_bot_user",
    });
    await c.publications.insert({
      tenantId: "tnt_acme",
      userId: "usr_alice",
      agentId: "agt_coder",
      installationId: inst.id,
      environmentId: "env_dev",
      mode: "full",
      status: "live",
      persona: { name: "Coder", avatarUrl: null },
      capabilities: new Set(),
      sessionGranularity: "per_issue",
    });
  });

  it("processes due rule (oauth_app), assigns up to max_concurrent issues, marks polled", async () => {
    const pubs = await c.publications.listByInstallation(
      (await c.installations.listByUser("usr_alice", "linear"))[0].id,
    );
    const rule = await c.dispatchRules.insert({
      tenantId: "tnt_acme",
      publicationId: pubs[0].id,
      name: "Auto-pickup",
      enabled: true,
      filterLabel: "bot-ready",
      filterStates: ["Todo"],
      filterProjectId: null,
      maxConcurrent: 2,
      pollIntervalSeconds: 60,
    });

    queueLinearResponses(c.http, [
      // combined candidate+load query: 3 matching issues + 0 currently assigned
      {
        candidates: {
          nodes: [
            { id: "iss_1", identifier: "ENG-1", title: "First", url: null, description: null },
            { id: "iss_2", identifier: "ENG-2", title: "Second", url: null, description: null },
            { id: "iss_3", identifier: "ENG-3", title: "Third", url: null, description: null },
          ],
        },
        load: { nodes: [] },
      },
      // assignMutation #1
      { issueUpdate: { success: true } },
      // assignMutation #2
      { issueUpdate: { success: true } },
    ]);

    const summary = await provider.runDispatchSweep(5_000_000_000);
    expect(summary.sweptRules).toBe(1);
    expect(summary.assignedIssues).toBe(2); // capped by max_concurrent
    expect(summary.errors).toEqual([]);

    const after = await c.dispatchRules.get(rule.id);
    expect(after!.lastPolledAt).toBe(5_000_000_000);
  });

  it("skips rule whose installation is revoked", async () => {
    const insts = await c.installations.listByUser("usr_alice", "linear");
    await c.installations.markRevoked(insts[0].id, 1234);
    const pubs = await c.publications.listByInstallation(insts[0].id);
    await c.dispatchRules.insert({
      tenantId: "tnt_acme",
      publicationId: pubs[0].id,
      name: "Auto-pickup",
      enabled: true,
      filterLabel: "bot-ready",
      filterStates: null,
      filterProjectId: null,
      maxConcurrent: 5,
      pollIntervalSeconds: 60,
    });
    // No HTTP responses queued — shouldn't be hit.
    const summary = await provider.runDispatchSweep(5_000_000_000);
    expect(summary.sweptRules).toBe(1);
    expect(summary.assignedIssues).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("respects poll interval — rule isn't picked up until interval has elapsed", async () => {
    const insts = await c.installations.listByUser("usr_alice", "linear");
    const pubs = await c.publications.listByInstallation(insts[0].id);
    const rule = await c.dispatchRules.insert({
      tenantId: "tnt_acme",
      publicationId: pubs[0].id,
      name: "r",
      enabled: true,
      filterLabel: "bot-ready",
      filterStates: null,
      filterProjectId: null,
      maxConcurrent: 1,
      pollIntervalSeconds: 600,
    });
    await c.dispatchRules.markPolled(rule.id, 1_000_000);

    // Only 100s after lastPolledAt — should NOT be due (interval=600).
    const due1 = await c.dispatchRules.listDueForSweep(1_000_100, 10);
    expect(due1).toHaveLength(0);

    // 700s after — should be due now.
    const due2 = await c.dispatchRules.listDueForSweep(1_000_700_000, 10);
    expect(due2).toHaveLength(1);
  });
});

describe("LinearProvider — async webhook flow (persist + ack + drain)", () => {
  let c: FakeContainer;
  let provider: LinearProvider;
  const APP_WEBHOOK_SECRET = "wh_secret_x";
  let appId: string;
  let instId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    c.tenants.set("usr_a", "tnt_acme");

    const app = await c.apps.insert({
      tenantId: "tnt_acme",
      publicationId: null,
      clientId: "client",
      clientSecret: "csec",
      webhookSecret: APP_WEBHOOK_SECRET,
    });
    appId = app.id;

    const inst = await c.installations.insert({
      tenantId: "tnt_acme",
      userId: "usr_a",
      providerId: "linear",
      workspaceId: "ws_acme",
      workspaceName: "Acme",
      installKind: "dedicated",
      appId,
      accessToken: "tok_oauth",
      refreshToken: null,
      scopes: ["read", "write"],
      botUserId: "lin_bot_user",
    });
    instId = inst.id;
    await c.installations.setVaultId(instId, "vlt_acme");

    const pub = await c.publications.insert({
      tenantId: "tnt_acme",
      userId: "usr_a",
      agentId: "agt_default",
      installationId: instId,
      environmentId: "env_dev",
      mode: "full",
      status: "live",
      persona: { name: "Bot", avatarUrl: null },
      capabilities: new Set(),
      sessionGranularity: "per_issue",
    });
    pubId = pub.id;
    await c.apps.setPublicationId(appId, pubId);
  });

  it("issueAssignedToYou webhook persists to pending_events, returns immediately, no session yet", async () => {
    const payload = JSON.stringify({
      type: "AppUserNotification",
      action: "issueAssignedToYou",
      webhookId: "del_async_1",
      organizationId: "ws_acme",
      notification: {
        type: "issueAssignedToYou",
        issue: { id: "iss_777", identifier: "ENG-777", title: "test", labels: { nodes: [] } },
        actor: { id: "usr_h", name: "Human" },
      },
    });
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_async_1",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${payload}` },
      rawBody: payload,
    });
    expect(out.handled).toBe(true);
    expect(out.reason).toContain("queued");
    // No sessions.create called synchronously
    expect(c.sessions.created).toHaveLength(0);
    // linear_events row enqueued (payload_json set, processed_at NULL)
    const queued = await c.webhookEvents.listUnprocessed(10);
    expect(queued).toHaveLength(1);
    expect(queued[0].eventKind).toBe("issueAssignedToYou");
    expect(queued[0].deliveryId).toBe("del_async_1");
  });

  it("drainPendingEvents processes queued event → sessions.create → marks processed", async () => {
    // Pre-seed a queued event by going through the merged-table path:
    // first record dedup row, then promote to actionable.
    const fakeNormalized = {
      kind: "issueAssignedToYou",
      workspaceId: "ws_acme",
      issueId: "iss_999",
      issueIdentifier: "ENG-999",
      issueTitle: "queued task",
      issueDescription: null,
      commentBody: null,
      commentId: null,
      labels: [],
      actorUserId: null,
      actorUserName: null,
      deliveryId: "del_x",
      eventType: "AppUserNotification",
    };
    await c.webhookEvents.recordIfNew("del_x", "tnt_acme", instId, "AppUserNotification", 1000);
    await c.webhookEvents.markActionable(
      "del_x",
      "issueAssignedToYou",
      pubId,
      JSON.stringify(fakeNormalized),
    );

    const summary = await provider.drainPendingEvents(2000, 10);
    expect(summary.drainedEvents).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    expect(c.sessions.created).toHaveLength(1);
    const created = c.sessions.created[0];
    expect(created.userId).toBe("usr_a");
    // hosted Linear MCP attached
    expect(created.mcpServers).toEqual([{ name: "linear", url: "https://mcp.linear.app/mcp" }]);

    // Row marked processed (no longer in unprocessed list)
    const remaining = await c.webhookEvents.listUnprocessed(10);
    expect(remaining).toHaveLength(0);
  });
});
