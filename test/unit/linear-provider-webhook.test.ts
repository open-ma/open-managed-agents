import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

const APP_WEBHOOK_SECRET = "wsec";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    gatewayOrigin: "https://gw",
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

async function seedDedicatedPublication(
  c: FakeContainer,
): Promise<{ instId: string; pubId: string }> {
  const app = await c.apps.insert({
    publicationId: null,
    clientId: "cid",
    clientSecret: "csec",
    webhookSecret: APP_WEBHOOK_SECRET,
  });
  const inst = await c.installations.insert({
    userId: "usr_a",
    providerId: "linear",
    workspaceId: "org_acme",
    workspaceName: "Acme",
    installKind: "dedicated",
    appId: app.id,
    accessToken: "lin_at",
    refreshToken: null,
    scopes: ["read", "write"],
    botUserId: "linbot",
  });
  await c.installations.setVaultId(inst.id, "vlt_acme");
  const pub = await c.publications.insert({
    userId: "usr_a",
    agentId: "agt_default",
    installationId: inst.id,
    environmentId: "env_dev",
    mode: "full",
    status: "live",
    persona: { name: "Triage", avatarUrl: null },
    capabilities: new Set(),
    sessionGranularity: "per_issue",
  });
  await c.apps.setPublicationId(app.id, pub.id);
  return { instId: inst.id, pubId: pub.id };
}

const ASSIGN_PAYLOAD = JSON.stringify({
  type: "AppUserNotification",
  action: "issueAssignedToYou",
  webhookId: "del_xyz",
  organizationId: "org_acme",
  notification: {
    type: "issueAssignedToYou",
    issue: {
      id: "iss_142",
      identifier: "ENG-142",
      title: "Auth bug",
      labels: { nodes: [] },
    },
    actor: { id: "usr_alice", name: "Alice" },
  },
});

describe("LinearProvider — handleWebhook (dedicated)", () => {
  let c: FakeContainer;
  let provider: LinearProvider;
  let instId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    const seeded = await seedDedicatedPublication(c);
    instId = seeded.instId;
    pubId = seeded.pubId;
  });

  it("rejects unsigned (no signature header)", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_1",
      headers: {},
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out).toEqual({ handled: false, reason: "missing_signature" });
  });

  it("rejects bad signature", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_1",
      headers: { "linear-signature": "bogus" },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out).toEqual({ handled: false, reason: "invalid_signature" });
  });

  it("rejects when installation is missing", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: "inst_does_not_exist",
      deliveryId: "del_1",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toMatch(/installation_not_found/);
  });

  it("dispatches a fresh session on first issueAssignedToYou", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_1",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });

    expect(out.handled).toBe(true);
    expect(out.publicationId).toBe(pubId);
    expect(out.sessionId).toBe("sess_1");

    expect(c.sessions.created).toHaveLength(1);
    const created = c.sessions.created[0];
    expect(created.userId).toBe("usr_a");
    expect(created.agentId).toBe("agt_default");
    expect(created.environmentId).toBe("env_dev");
    expect(created.vaultIds).toEqual(["vlt_acme"]);
    // Provider no longer passes mcp.linear.app directly — apps/main wires
    // the OMA-hosted Linear MCP (integrations.openma.dev/linear/mcp/...)
    // based on session metadata. See provider.ts:516 for the rationale.
    expect(created.mcpServers).toEqual([]);

    const issueSession = await c.issueSessions.getByIssue(pubId, "iss_142");
    expect(issueSession?.status).toBe("active");
    expect(issueSession?.sessionId).toBe("sess_1");
  });

  it("resumes the same session for a subsequent comment on the same issue", async () => {
    await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_1",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });

    const COMMENT_PAYLOAD = JSON.stringify({
      type: "AppUserNotification",
      action: "issueCommentMention",
      webhookId: "del_2",
      organizationId: "org_acme",
      notification: {
        type: "issueCommentMention",
        issue: { id: "iss_142", identifier: "ENG-142", title: "Auth bug", labels: { nodes: [] } },
        comment: { id: "cmt_1", body: "any update?" },
        actor: { id: "usr_bob", name: "Bob" },
      },
    });

    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_2",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${COMMENT_PAYLOAD}` },
      rawBody: COMMENT_PAYLOAD,
    });

    expect(out.handled).toBe(true);
    expect(out.sessionId).toBe("sess_1");
    expect(c.sessions.created).toHaveLength(1);
    expect(c.sessions.resumed).toHaveLength(1);
    expect(c.sessions.resumed[0].sessionId).toBe("sess_1");
    expect(c.sessions.resumed[0].userId).toBe("usr_a");
  });

  it("dedupes duplicate delivery_id", async () => {
    const out1 = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_dup",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out1.handled).toBe(true);

    const out2 = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_dup",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out2).toEqual({ handled: false, reason: "duplicate_delivery" });

    expect(c.sessions.created).toHaveLength(1);
  });

  it("drops events when the install has no live publication", async () => {
    await c.publications.markUnpublished(pubId, c.clock.nowMs());

    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: instId,
      deliveryId: "del_3",
      headers: { "linear-signature": `expected:${APP_WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe("no_live_publication");
    expect(c.sessions.created).toHaveLength(0);
  });
});
