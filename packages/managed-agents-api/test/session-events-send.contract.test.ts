import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { sessionWire } from "./session-fixtures";
import { buildSessionEventsTestApi } from "./test-api";

describe("Managed Agents API — POST /v1/sessions/:session_id/events", () => {
  it.each(["version_conflict", "idempotency_conflict"] as const)("preserves native %s as HTTP 409", async type => {
    const api = buildSessionEventsTestApi(makeSessionEventsPort({ sendSessionEvents: async () => ({ type, message: "Input conflicts with the accepted Session state" }) }));
    const client = new Anthropic({ apiKey: "test-key", baseURL: "http://openma.test", maxRetries: 0, fetch: async (input, init) => api.fetch(new Request(input, init)) });
    await expect(client.beta.sessions.events.send(sessionWire.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] })).rejects.toMatchObject({ status: 409 });
  });

  it("maps user.tool_result followed by its final system.message", async () => {
    const sendCalls: unknown[] = [];
    const port = makeSessionEventsPort({
      sendSessionEvents: async (command) => {
        sendCalls.push(command);
        return {
          type: "accepted",
          events: [
            {
              id: "event_tool_result_01",
              type: "user.tool_result",
              toolUseId: "tool_use_01",
              content: [{ type: "text", text: "command completed" }],
              isError: false,
              processedAt: "2026-08-26T04:00:01.000Z",
              sessionThreadId: "thread_01",
            },
            {
              id: "event_system_01",
              type: "system.message",
              content: [{ type: "text", text: "Use the migration checklist" }],
              processedAt: "2026-08-26T04:00:02.000Z",
            },
          ],
        };
      },
    });
    const api = buildSessionEventsTestApi(port);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    const result = await client.beta.sessions.events.send(sessionWire.id, {
      events: [
        {
          type: "user.tool_result",
          tool_use_id: "tool_use_01",
          content: [{ type: "text", text: "command completed" }],
          is_error: false,
        },
        {
          type: "system.message",
          content: [{ type: "text", text: "Use the migration checklist" }],
        },
      ],
    });

    expect(sendCalls).toEqual([
      {
        sessionId: sessionWire.id,
        events: [
          {
            type: "user.tool_result",
            toolUseId: "tool_use_01",
            content: [{ type: "text", text: "command completed" }],
            isError: false,
          },
          {
            type: "system.message",
            content: [{ type: "text", text: "Use the migration checklist" }],
          },
        ],
      },
    ]);
    expect(result).toEqual({
      data: [
        {
          id: "event_tool_result_01",
          type: "user.tool_result",
          tool_use_id: "tool_use_01",
          content: [{ type: "text", text: "command completed" }],
          is_error: false,
          processed_at: "2026-08-26T04:00:01.000Z",
          session_thread_id: "thread_01",
        },
        {
          id: "event_system_01",
          type: "system.message",
          content: [{ type: "text", text: "Use the migration checklist" }],
          processed_at: "2026-08-26T04:00:02.000Z",
        },
      ],
    });
  });

  it.each([
    {
      name: "a system.message that is not final",
      events: [
        {
          type: "user.message" as const,
          content: [{ type: "text" as const, text: "Start" }],
        },
        {
          type: "system.message" as const,
          content: [{ type: "text" as const, text: "Privileged context" }],
        },
        {
          type: "user.message" as const,
          content: [{ type: "text" as const, text: "Continue" }],
        },
      ],
    },
    {
      name: "a standalone system.message",
      events: [
        {
          type: "system.message" as const,
          content: [{ type: "text" as const, text: "Privileged context" }],
        },
      ],
    },
    {
      name: "deny_message on an allow verdict",
      events: [
        {
          type: "user.tool_confirmation" as const,
          result: "allow" as const,
          tool_use_id: "tool_use_01",
          deny_message: "should not be present",
        },
      ],
    },
  ])("rejects $name before invoking the application port", async ({ events }) => {
    let calls = 0;
    const api = buildSessionEventsTestApi(makeSessionEventsPort({
      sendSessionEvents: async () => {
        calls += 1;
        return { type: "accepted" };
      },
    }));
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        return api.fetch(request);
      },
    });

    await expect(client.beta.sessions.events.send(sessionWire.id, {
      events,
    })).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(0);
  });
});
