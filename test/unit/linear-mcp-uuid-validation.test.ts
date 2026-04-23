// Regression tests for Linear MCP tool handlers.
//
// Today these focus on bug_002 (UUID validation in linear_get_issue).
// parentCommentId is interpolated into a GraphQL query string (Linear's
// `comments(filter:...)` doesn't accept Variables for the equality
// predicates), so an LLM-supplied non-UUID value could smuggle sibling
// selections. The handler must reject anything that doesn't match UUID_RE
// *before* hitting GraphQL.

import { describe, it, expect } from "vitest";
import { __testInternals } from "../../apps/integrations/src/routes/linear/mcp";

const { TOOLS, UUID_RE } = __testInternals;

const linearGetIssue = TOOLS.find((t) => t.name === "linear_get_issue")!;

interface GraphQLCall {
  query: string;
  variables?: Record<string, unknown>;
}

function makeCtx(issueId: string | null = "11111111-1111-1111-1111-111111111111") {
  const calls: GraphQLCall[] = [];
  return {
    calls,
    ctx: {
      sessionId: "sess-test",
      userId: "u",
      publicationId: "p",
      installationId: "i",
      linearGraphQL: async (payload: GraphQLCall) => {
        calls.push(payload);
        return {
          data: {
            issue: {
              id: issueId,
              identifier: "TST-1",
              title: "t",
              description: null,
              url: "https://linear.app/x/issue/TST-1",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              priority: 0,
              priorityLabel: "None",
              state: { name: "Todo", type: "unstarted" },
              assignee: null,
              creator: null,
              labels: { nodes: [] },
              comments: { nodes: [] },
            },
          },
        };
      },
      recordAuthoredComment: async () => {},
      issueId,
    },
  };
}

describe("UUID_RE pattern (bug_002 building block)", () => {
  it("accepts canonical lowercase v4 UUIDs", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
  it("accepts uppercase UUIDs", () => {
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  // GraphQL injection payloads — the actual attack surface.
  const injections = [
    'fake"} } { id:{eq:"X',
    "} OR 1=1 --",
    'x"}}){ nodes{id}}}#',
    "}}, parent:{null:false}",
    '" OR true #',
    "550e8400-e29b-41d4-a716-446655440000\" OR 1=1 \"",
  ];
  for (const payload of injections) {
    it(`rejects injection payload: ${JSON.stringify(payload)}`, () => {
      expect(UUID_RE.test(payload)).toBe(false);
    });
  }

  it("rejects empty / short / unhyphenated strings", () => {
    expect(UUID_RE.test("")).toBe(false);
    expect(UUID_RE.test("550e8400")).toBe(false);
    expect(UUID_RE.test("550e8400e29b41d4a716446655440000")).toBe(false);
  });
});

describe("linear_get_issue handler (ultrareview bug_002)", () => {
  it("returns errorResult and does NOT call GraphQL when parentCommentId is not a UUID", async () => {
    const { ctx, calls } = makeCtx();
    const result = await linearGetIssue.handler(ctx, {
      parentCommentId: 'fake"} } { id:{eq:"X',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/parentCommentId must be a UUID/);
    expect(calls.length).toBe(0);
  });

  it("rejects each known injection payload before GraphQL", async () => {
    const injections = [
      "} OR 1=1 --",
      'x"}}){ nodes{id}}}#',
      "}}, parent:{null:false}",
      "not-a-uuid",
    ];
    for (const payload of injections) {
      const { ctx, calls } = makeCtx();
      const result = await linearGetIssue.handler(ctx, { parentCommentId: payload });
      expect(result.isError, `payload=${payload}`).toBe(true);
      expect(calls.length, `payload=${payload}`).toBe(0);
    }
  });

  it("accepts a valid UUID and forwards to GraphQL with the id interpolated literally", async () => {
    const { ctx, calls } = makeCtx();
    const validUuid = "11111111-2222-3333-4444-555555555555";
    const result = await linearGetIssue.handler(ctx, {
      issueId: "22222222-2222-3333-4444-555555555555",
      parentCommentId: validUuid,
    });
    expect(result.isError).not.toBe(true);
    expect(calls.length).toBe(1);
    // Sanity: the query string mentions the parentCommentId — confirms
    // the interpolation path runs (validation didn't bypass it).
    expect(calls[0].query).toContain(validUuid);
  });

  it("works with no parentCommentId (top-level comments path)", async () => {
    const { ctx, calls } = makeCtx();
    const result = await linearGetIssue.handler(ctx, {
      issueId: "22222222-2222-3333-4444-555555555555",
    });
    expect(result.isError).not.toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].query).toContain("parent:{ null:true }");
  });

  it("requires issueId (no fallback) when ctx has no bound issue", async () => {
    const { ctx, calls } = makeCtx(null);
    const result = await linearGetIssue.handler(ctx, {});
    expect(result.isError).toBe(true);
    expect(calls.length).toBe(0);
  });
});
