import { describe, it, expect } from "vitest";
import { parseWebhook, type RawWebhookEnvelope } from "../../packages/linear/src/webhook/parse";

describe("Linear webhook parser", () => {
  it("returns null when delivery_id is missing — can't dedupe", () => {
    expect(parseWebhook({ type: "AppUserNotification" })).toBeNull();
  });

  it("normalizes issueAssignedToYou notification", () => {
    const raw: RawWebhookEnvelope = {
      type: "AppUserNotification",
      action: "issueAssignedToYou",
      webhookId: "del_123",
      organizationId: "org_acme",
      notification: {
        type: "issueAssignedToYou",
        issue: {
          id: "iss_142",
          identifier: "ENG-142",
          title: "Fix the auth bug",
          description: "Users with...",
          labels: { nodes: [{ name: "bug" }, { name: "agent:coder" }] },
        },
        actor: { id: "usr_alice", name: "Alice" },
      },
    };
    const event = parseWebhook(raw);
    expect(event).toMatchObject({
      kind: "issueAssignedToYou",
      workspaceId: "org_acme",
      issueId: "iss_142",
      issueIdentifier: "ENG-142",
      issueTitle: "Fix the auth bug",
      labels: ["bug", "agent:coder"],
      actorUserId: "usr_alice",
      actorUserName: "Alice",
      deliveryId: "del_123",
    });
  });

  it("normalizes issueCommentMention with comment body", () => {
    const event = parseWebhook({
      type: "AppUserNotification",
      action: "issueCommentMention",
      webhookId: "del_456",
      organizationId: "org_acme",
      notification: {
        type: "issueCommentMention",
        issue: { id: "iss_99", identifier: "ENG-99", title: "T" },
        comment: { id: "cmt_1", body: "@OpenMA /coder please look" },
        actor: { id: "usr_bob", name: "Bob" },
      },
    });
    expect(event?.kind).toBe("issueCommentMention");
    expect(event?.commentBody).toBe("@OpenMA /coder please look");
    expect(event?.commentId).toBe("cmt_1");
  });

  it("returns kind=null but valid event for unsupported subtypes", () => {
    const event = parseWebhook({
      type: "AppUserNotification",
      action: "issueDueDate",
      webhookId: "del_789",
      organizationId: "org_acme",
      notification: { type: "issueDueDate", issue: { id: "iss_1" } },
    });
    expect(event?.kind).toBeNull();
    expect(event?.deliveryId).toBe("del_789");
  });

  it("treats top-level events outside AppUserNotification as no-op kind=null", () => {
    const event = parseWebhook({
      type: "Issue",
      action: "create",
      webhookId: "del_iss",
      organizationId: "org_acme",
      data: { id: "iss_2" },
    });
    expect(event?.kind).toBeNull();
  });
});
