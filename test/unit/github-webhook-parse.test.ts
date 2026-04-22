import { describe, it, expect } from "vitest";
import {
  parseWebhook,
  type RawWebhookEnvelope,
} from "../../packages/github/src/webhook/parse";

const BOT = "myapp[bot]";

function env(overrides: Partial<RawWebhookEnvelope> = {}): RawWebhookEnvelope {
  return {
    installation: { id: 12345 },
    repository: {
      id: 1,
      name: "api",
      full_name: "acme/api",
      html_url: "https://github.com/acme/api",
      default_branch: "main",
    },
    sender: { id: 99, login: "alice" },
    ...overrides,
  };
}

describe("GitHub webhook parser", () => {
  it("returns null when delivery id is missing — can't dedupe", () => {
    expect(
      parseWebhook({
        eventType: "issues",
        deliveryId: "",
        raw: env(),
        botLogin: BOT,
      }),
    ).toBeNull();
  });

  it("issues.assigned to bot → kind=issue_assigned", () => {
    const event = parseWebhook({
      eventType: "issues",
      deliveryId: "del_1",
      botLogin: BOT,
      raw: env({
        action: "assigned",
        issue: {
          id: 1,
          number: 142,
          title: "Fix the auth bug",
          body: "Details...",
          state: "open",
          html_url: "https://github.com/acme/api/issues/142",
          assignees: [{ id: 1, login: BOT }],
          labels: [{ name: "bug" }, { name: "Agent:Coder" }],
        },
      }),
    });
    expect(event).toMatchObject({
      kind: "issue_assigned",
      installationId: "12345",
      repository: "acme/api",
      itemNumber: 142,
      itemKind: "issue",
      itemTitle: "Fix the auth bug",
      labels: ["bug", "agent:coder"],
      actorLogin: "alice",
      deliveryId: "del_1",
      eventType: "issues",
      action: "assigned",
    });
  });

  it("issues.assigned to a human (not bot) → kind=null", () => {
    const event = parseWebhook({
      eventType: "issues",
      deliveryId: "del_1",
      botLogin: BOT,
      raw: env({
        action: "assigned",
        issue: {
          id: 1, number: 1, title: "x", state: "open",
          assignees: [{ id: 99, login: "alice" }], // not the bot
        },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("issues.opened → kind=null in default matrix (opt-in via future --mode triage)", () => {
    const event = parseWebhook({
      eventType: "issues",
      deliveryId: "del_2",
      botLogin: BOT,
      raw: env({
        action: "opened",
        issue: { id: 1, number: 7, title: "Hi", state: "open" },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("issue_comment with @<bot> mention → kind=issue_mentioned", () => {
    const event = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_3",
      botLogin: BOT,
      raw: env({
        action: "created",
        issue: { id: 1, number: 7, title: "T", state: "open" },
        comment: { id: 100, body: `Hey @${BOT}, please look at this.` },
      }),
    });
    expect(event?.kind).toBe("issue_mentioned");
    expect(event?.commentBody).toContain("please look");
  });

  it("issue_comment without bot mention → kind=null in default matrix", () => {
    const event = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_4",
      botLogin: BOT,
      raw: env({
        action: "created",
        issue: { id: 1, number: 7, title: "T", state: "open" },
        comment: { id: 101, body: "just a normal comment" },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("issue_comment on a PR (issue.pull_request set) → routes as PR", () => {
    const event = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_5",
      botLogin: BOT,
      raw: env({
        action: "created",
        issue: {
          id: 1,
          number: 42,
          title: "feat: x",
          state: "open",
          pull_request: { html_url: "https://github.com/acme/api/pull/42" },
        },
        comment: { id: 200, body: `@${BOT} take a look` },
      }),
    });
    expect(event?.kind).toBe("pr_mentioned");
    expect(event?.itemKind).toBe("pull_request");
  });

  it("pull_request.review_requested → kind=pr_review_requested when bot is the reviewer", () => {
    const event = parseWebhook({
      eventType: "pull_request",
      deliveryId: "del_6",
      botLogin: BOT,
      raw: env({
        action: "review_requested",
        pull_request: {
          id: 1,
          number: 42,
          title: "feat: x",
          state: "open",
          user: { id: 99, login: "alice" },
          head: { ref: "feat/x", sha: "abc" },
          base: { ref: "main", sha: "def" },
          requested_reviewers: [{ id: 1, login: BOT }],
        },
      }),
    });
    expect(event?.kind).toBe("pr_review_requested");
  });

  it("pull_request.review_requested where reviewer is a human → kind=null", () => {
    const event = parseWebhook({
      eventType: "pull_request",
      deliveryId: "del_6",
      botLogin: BOT,
      raw: env({
        action: "review_requested",
        pull_request: {
          id: 1, number: 42, title: "x", state: "open",
          head: { ref: "f", sha: "a" }, base: { ref: "main", sha: "b" },
          requested_reviewers: [{ id: 99, login: "bob" }],
        },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("pull_request_review.submitted → kind=pr_review_submitted when bot was the requested reviewer", () => {
    const event = parseWebhook({
      eventType: "pull_request_review",
      deliveryId: "del_7",
      botLogin: BOT,
      raw: env({
        action: "submitted",
        pull_request: {
          id: 1, number: 42, title: "x", state: "open",
          head: { ref: "f", sha: "a" }, base: { ref: "main", sha: "b" },
          requested_reviewers: [{ id: 1, login: BOT }],
        },
        review: { id: 9, state: "approved", body: "LGTM", user: { id: 99, login: "alice" } },
      }),
    });
    expect(event?.kind).toBe("pr_review_submitted");
    expect(event?.commentBody).toBe("LGTM");
  });

  it("pull_request_review.submitted by someone where bot was NOT requested → kind=null", () => {
    const event = parseWebhook({
      eventType: "pull_request_review",
      deliveryId: "del_7b",
      botLogin: BOT,
      raw: env({
        action: "submitted",
        pull_request: {
          id: 1, number: 42, title: "x", state: "open",
          head: { ref: "f", sha: "a" }, base: { ref: "main", sha: "b" },
          requested_reviewers: [],
        },
        review: { id: 9, state: "approved", body: "LGTM" },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("workflow_run.completed with conclusion=failure → kind=null in default matrix (opt-in via --mode ci-watch)", () => {
    const event = parseWebhook({
      eventType: "workflow_run",
      deliveryId: "del_8",
      botLogin: BOT,
      raw: env({
        action: "completed",
        workflow_run: { id: 1, name: "ci", conclusion: "failure", html_url: "https://x" },
      }),
    });
    expect(event?.kind).toBeNull();
    // Still recorded for observability.
    expect(event?.itemTitle).toBe("ci");
  });

  it("workflow_run.completed with conclusion=success → kind=null", () => {
    const event = parseWebhook({
      eventType: "workflow_run",
      deliveryId: "del_9",
      botLogin: BOT,
      raw: env({
        action: "completed",
        workflow_run: { id: 1, name: "ci", conclusion: "success" },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("self-wakeup guard: any event where sender == bot → kind=null", () => {
    // Without this filter, the bot's own comment fires `issue_comment.created`
    // with sender==bot and would trigger the bot to reply to itself ad infinitum.
    const event = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_self",
      botLogin: BOT,
      raw: env({
        action: "created",
        sender: { id: 1, login: BOT, type: "Bot" },  // bot is the actor
        issue: { id: 1, number: 7, title: "T", state: "open" },
        comment: { id: 999, body: `Replying to @${BOT}` },  // even with @<bot>
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("self-wakeup guard: bot assigning bot to issue → kind=null", () => {
    const event = parseWebhook({
      eventType: "issues",
      deliveryId: "del_self2",
      botLogin: BOT,
      raw: env({
        action: "assigned",
        sender: { id: 1, login: BOT, type: "Bot" },
        issue: {
          id: 1, number: 1, title: "T", state: "open",
          assignees: [{ id: 1, login: BOT }],
        },
      }),
    });
    expect(event?.kind).toBeNull();
  });

  it("installation.created → kind=installation_created (lifecycle event)", () => {
    const event = parseWebhook({
      eventType: "installation",
      deliveryId: "del_10",
      botLogin: BOT,
      raw: { action: "created", installation: { id: 12345 } },
    });
    expect(event?.kind).toBe("installation_created");
  });

  it("ignores partial @-prefix (e.g. @myapp must NOT match inside @myappy)", () => {
    // True positive case (@<bot> at word boundary) → issue_mentioned
    const positive = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_p",
      botLogin: "myapp",
      raw: env({
        action: "created",
        issue: { id: 1, number: 7, title: "T", state: "open" },
        comment: { id: 102, body: "see @myapp for details" },
      }),
    });
    expect(positive?.kind).toBe("issue_mentioned");
    // Negative case (`@myapp` is a prefix of `@myappy`) → null
    const negative = parseWebhook({
      eventType: "issue_comment",
      deliveryId: "del_n",
      botLogin: "myapp",
      raw: env({
        action: "created",
        issue: { id: 1, number: 7, title: "T", state: "open" },
        comment: { id: 103, body: "see @myappy for details" },
      }),
    });
    expect(negative?.kind).toBeNull();
  });

  it("falls through to kind=null for events we receive but don't act on (push)", () => {
    const event = parseWebhook({
      eventType: "push",
      deliveryId: "del_12",
      botLogin: BOT,
      raw: env(),
    });
    expect(event?.kind).toBeNull();
    expect(event?.deliveryId).toBe("del_12");
  });
});
