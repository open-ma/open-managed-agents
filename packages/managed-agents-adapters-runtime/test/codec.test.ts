import { describe, expect, it } from "vitest";
import {
  decodeRuntimeEvent,
  decodeRuntimeProducedSessionEvent,
  encodeRuntimeSessionEvent,
  encodeRuntimeSessionStart,
  RuntimeEventStreamDecoder,
} from "../src";
import type {
  SessionEventView,
  StartSessionExecution,
} from "@open-managed-agents/managed-agents-application";
import * as runtimeCodec from "../src";

describe("Managed session runtime codec", () => {
  it("encodes accepted application events without API or SDK DTO dependencies", () => {
    expect(
      encodeRuntimeSessionEvent({
        id: "event_01",
        type: "user.tool_confirmation",
        result: "deny",
        toolUseId: "toolu_01",
        denyMessage: "No",
        processedAt: "2026-08-26T00:00:00.000Z",
      }),
    ).toEqual({
      id: "event_01",
      type: "user.tool_confirmation",
      result: "deny",
      tool_use_id: "toolu_01",
      deny_message: "No",
      processed_at: "2026-08-26T00:00:00.000Z",
    });
  });

  it("decodes committed and delta events while rejecting extension output", () => {
    expect(
      decodeRuntimeEvent(
        { type: "agent.message_chunk", message_id: "event_01", delta: "Hi" },
        new Set(["agent.message"]),
      ),
    ).toEqual([
      {
        type: "event_delta",
        eventId: "event_01",
        delta: {
          type: "content_delta",
          content: { type: "text", text: "Hi" },
        },
      },
    ]);
    expect(
      decodeRuntimeProducedSessionEvent({
        id: "event_02",
        type: "session.status_running",
        processed_at: "2026-08-26T00:00:01.000Z",
      }),
    ).toEqual({
      id: "event_02",
      type: "session.status_running",
      processedAt: "2026-08-26T00:00:01.000Z",
    });
    expect(
      decodeRuntimeEvent({ type: "session.warning", message: "extension" }, new Set()),
    ).toEqual([]);
  });

  it.each(["agent.tool_result", "agent.mcp_tool_result"] as const)(
    "normalizes legacy string content on %s into official content blocks",
    (type) => {
      expect(
        decodeRuntimeProducedSessionEvent({
          id: "event_result_01",
          type,
          ...(type === "agent.tool_result"
            ? { tool_use_id: "event_use_01" }
            : { mcp_tool_use_id: "event_use_01" }),
          content: "tool output",
          processed_at: "2026-08-26T00:00:01.000Z",
        }),
      ).toMatchObject({
        id: "event_result_01",
        type,
        content: [{ type: "text", text: "tool output" }],
      });
    },
  );

  it("normalizes a failed model span that has no usage payload", () => {
    expect(
      decodeRuntimeEvent(
        {
          id: "event_model_end_01",
          type: "span.model_request_end",
          model_request_start_id: "event_model_start_01",
          processed_at: "2026-08-26T00:00:02.000Z",
        },
        new Set(),
      ),
    ).toEqual([
      {
        id: "event_model_end_01",
        type: "span.model_request_end",
        modelRequestStartId: "event_model_start_01",
        processedAt: "2026-08-26T00:00:02.000Z",
        isError: null,
        modelUsage: {
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    ]);
  });

  it("keeps live model span pairs valid when a runtime end frame omits its correlation id", () => {
    const decoder = new RuntimeEventStreamDecoder(new Set());

    expect(
      decoder.decode({
        id: "event_model_start_01",
        type: "span.model_request_start",
        processed_at: "2026-08-26T00:00:01.000Z",
      }),
    ).toEqual([
      {
        id: "event_model_start_01",
        type: "span.model_request_start",
        processedAt: "2026-08-26T00:00:01.000Z",
      },
    ]);
    expect(
      decoder.decode({
        id: "event_model_end_01",
        type: "span.model_request_end",
        is_error: true,
        processed_at: "2026-08-26T00:00:02.000Z",
      }),
    ).toEqual([
      {
        id: "event_model_end_01",
        type: "span.model_request_end",
        isError: true,
        modelRequestStartId: "event_model_start_01",
        modelUsage: {
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        processedAt: "2026-08-26T00:00:02.000Z",
      },
    ]);
  });

  it("uses the streamed block id for the committed message correlation", () => {
    expect(
      decodeRuntimeEvent(
        {
          id: "event_log_01",
          type: "agent.message",
          message_id: "message_01",
          content: [{ type: "text", text: "Hello" }],
          processed_at: "2026-08-26T00:00:03.000Z",
        },
        new Set(),
      ),
    ).toEqual([
      {
        id: "message_01",
        type: "agent.message",
        messageId: "message_01",
        content: [{ type: "text", text: "Hello" }],
        processedAt: "2026-08-26T00:00:03.000Z",
      },
    ]);
  });

  it("encodes complete application history at the runtime boundary", () => {
    const encode = (
      runtimeCodec as typeof runtimeCodec & {
        encodeRuntimeHistoryEvent?: (event: SessionEventView) => object;
      }
    ).encodeRuntimeHistoryEvent ?? ((event: SessionEventView) => event);
    const event: SessionEventView = {
      id: "event_model_01",
      type: "span.model_request_end",
      isError: false,
      modelRequestStartId: "event_model_start_01",
      modelUsage: {
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        inputTokens: 5,
        outputTokens: 8,
      },
      processedAt: "2026-08-26T00:00:02.000Z",
    };

    expect(encode(event)).toEqual({
      id: "event_model_01",
      type: "span.model_request_end",
      is_error: false,
      model_request_start_id: "event_model_start_01",
      model_usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        input_tokens: 5,
        output_tokens: 8,
      },
      processed_at: "2026-08-26T00:00:02.000Z",
    });
  });

  it("encodes resolved Agent definitions only at the final runtime boundary", () => {
    const input: StartSessionExecution = {
      workspaceId: "workspace_01",
      sessionId: "session_01",
      session: {
        id: "session_01",
        agent: {
          id: "agent_coordinator",
          description: "Coordinates specialists",
          mcpServers: [
            { type: "url", name: "docs", url: "https://mcp.test" },
          ],
          model: {
            id: "claude-opus-5",
            effort: "high",
            inferenceGeo: "us",
            providerOptions: {
              pi: { reasoning: "high", sampling: { temperature: 0 } },
            },
            speed: "fast",
          },
          multiagent: {
            type: "coordinator",
            agents: [
              {
                type: "agent",
                id: "agent_reviewer",
                description: null,
                mcpServers: [],
                model: { id: "claude-sonnet-4-6" },
                name: "Reviewer",
                skills: [],
                system: null,
                tools: [],
                version: 7,
              },
              { type: "advisor", model: "claude-haiku-4-5" },
            ],
          },
          name: "Coordinator",
          skills: [
            { type: "custom", skillId: "skill_review", version: "3" },
          ],
          system: "Coordinate carefully",
          tools: [
            {
              type: "agent_toolset_20260401",
              defaultConfig: {
                enabled: false,
                permissionPolicy: { type: "always_ask" },
              },
              configs: [
                {
                  type: "web_fetch",
                  name: "web_fetch",
                  enabled: true,
                  permissionPolicy: { type: "always_allow" },
                  allowedDomains: ["docs.example.com"],
                  blockedDomains: ["private.example.com"],
                  maxContentTokens: 4096,
                },
              ],
            },
            {
              type: "mcp_toolset",
              mcpServerName: "docs",
              defaultConfig: {
                enabled: true,
                permissionPolicy: { type: "always_ask" },
              },
              configs: [
                {
                  name: "search",
                  enabled: true,
                  permissionPolicy: { type: "always_allow" },
                },
              ],
            },
            {
              type: "custom",
              name: "release",
              description: "Release the service",
              inputSchema: {
                type: "object",
                properties: { tag: { type: "string" } },
                required: ["tag"],
              },
            },
          ],
          version: 4,
        },
        archivedAt: null,
        budget: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        environmentId: "env_01",
        metadata: {},
        outcomeEvaluations: [],
        resources: [],
        stats: {},
        status: "running",
        title: "Ship the migration",
        updatedAt: "2026-08-26T00:00:01.000Z",
        usage: {},
        vaultIds: [],
      },
      environment: {
        id: "env_01",
        archivedAt: null,
        config: { type: "self_hosted" },
        createdAt: "2026-08-25T00:00:00.000Z",
        description: null,
        metadata: {},
        name: "Local runtime",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      initialEvents: [],
    };

    expect(encodeRuntimeSessionStart(input)).toMatchObject({
      agent_snapshot: {
        model: {
          id: "claude-opus-5",
          effort: "high",
          inference_geo: "us",
          provider_options: {
            pi: { reasoning: "high", sampling: { temperature: 0 } },
          },
          speed: "fast",
        },
        skills: [
          { type: "custom", skill_id: "skill_review", version: "3" },
        ],
        tools: [
          {
            type: "agent_toolset_20260401",
            default_config: {
              enabled: false,
              permission_policy: { type: "always_ask" },
            },
            configs: [
              {
                name: "web_fetch",
                enabled: true,
                permission_policy: { type: "always_allow" },
                allowed_domains: ["docs.example.com"],
                blocked_domains: ["private.example.com"],
                max_content_tokens: 4096,
              },
            ],
          },
          {
            type: "mcp_toolset",
            mcp_server_name: "docs",
            default_config: {
              enabled: true,
              permission_policy: { type: "always_ask" },
            },
            configs: [
              {
                name: "search",
                enabled: true,
                permission_policy: { type: "always_allow" },
              },
            ],
          },
          {
            type: "custom",
            name: "release",
            description: "Release the service",
            input_schema: {
              type: "object",
              properties: { tag: { type: "string" } },
              required: ["tag"],
            },
          },
        ],
        callable_agents: [
          { type: "agent", id: "agent_reviewer", version: 7 },
        ],
      },
    });
  });
});
