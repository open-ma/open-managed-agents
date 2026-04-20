import { describe, it, expect } from "vitest";
import { routeForSharedInstall } from "../../packages/linear/src/webhook/router";
import type {
  NormalizedWebhookEvent,
} from "../../packages/linear/src/webhook/parse";
import type { Publication } from "@open-managed-agents/integrations-core";

function pub(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub_x",
    userId: "usr",
    agentId: "agt",
    installationId: "inst",
    environmentId: "env",
    mode: "quick",
    status: "live",
    persona: { name: "Coder", avatarUrl: null },
    slashCommand: "/coder",
    capabilities: new Set(["issue.read", "comment.write"]),
    sessionGranularity: "per_issue",
    isDefaultAgent: false,
    createdAt: 0,
    unpublishedAt: null,
    ...overrides,
  };
}

function event(overrides: Partial<NormalizedWebhookEvent> = {}): NormalizedWebhookEvent {
  return {
    kind: "issueCommentMention",
    workspaceId: "org",
    issueId: "iss",
    issueIdentifier: "ENG-1",
    issueTitle: null,
    issueDescription: null,
    commentBody: null,
    commentId: null,
    labels: [],
    actorUserId: null,
    actorUserName: null,
    deliveryId: "del",
    eventType: "AppUserNotification",
    ...overrides,
  };
}

describe("routeForSharedInstall", () => {
  it("drops events with no kind", () => {
    const r = routeForSharedInstall(event({ kind: null }), [pub()], pub({ isDefaultAgent: true }));
    expect(r).toEqual({ publication: null, reason: "unsupported_event" });
  });

  it("matches slash command in comment body", () => {
    const coder = pub({ id: "p_coder", slashCommand: "/coder" });
    const designer = pub({ id: "p_des", slashCommand: "/designer" });
    const r = routeForSharedInstall(
      event({ commentBody: "hey @OpenMA /designer can you mock this?" }),
      [coder, designer],
      coder,
    );
    expect(r).toEqual({ publication: designer, reason: "slash_command" });
  });

  it("slash takes precedence over default", () => {
    const coder = pub({ id: "p_coder", slashCommand: "/coder", isDefaultAgent: true });
    const designer = pub({ id: "p_des", slashCommand: "/designer" });
    const r = routeForSharedInstall(
      event({ commentBody: "Need help with /designer review" }),
      [coder, designer],
      coder,
    );
    expect(r.publication).toBe(designer);
    expect(r.reason).toBe("slash_command");
  });

  it("matches agent:label when slash absent", () => {
    const coder = pub({ id: "p_coder", slashCommand: "/coder" });
    const r = routeForSharedInstall(
      event({ labels: ["bug", "agent:coder"] }),
      [coder],
      null,
    );
    expect(r).toEqual({ publication: coder, reason: "agent_label" });
  });

  it("falls back to default agent when no slash + no matching label", () => {
    const coder = pub({ id: "p_coder", isDefaultAgent: true });
    const r = routeForSharedInstall(
      event({ commentBody: "just FYI" }),
      [coder],
      coder,
    );
    expect(r).toEqual({ publication: coder, reason: "default_agent" });
  });

  it("returns no_match when nothing routes", () => {
    const coder = pub({ slashCommand: "/coder" });
    const r = routeForSharedInstall(
      event({ commentBody: "no mention" }),
      [coder],
      null,
    );
    expect(r).toEqual({ publication: null, reason: "no_match" });
  });

  it("ignores non-live publications", () => {
    const inactive = pub({ slashCommand: "/coder", status: "unpublished" });
    const r = routeForSharedInstall(
      event({ commentBody: "/coder do it" }),
      [inactive],
      null,
    );
    expect(r.publication).toBeNull();
  });

  it("slash word boundary: /coder doesn't match /coder-bot", () => {
    const coder = pub({ slashCommand: "/coder" });
    const r = routeForSharedInstall(
      event({ commentBody: "use the /coder-bot command" }),
      [coder],
      null,
    );
    expect(r.publication).toBeNull();
  });
});
