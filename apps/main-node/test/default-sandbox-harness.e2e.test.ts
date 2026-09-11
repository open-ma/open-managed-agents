import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

import {
  createScriptedLanguageModel,
  finishChunk,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../../../test/fakes/scripted-language-model";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import type { HarnessRuntime } from "@open-managed-agents/agent/harness/interface";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

/**
 * Host-side harness conformance: the loop remains in the Node host, while a
 * real SandboxPort owns the side effect. This is intentionally separate from
 * the ACP test, whose agent process itself runs inside the sandbox.
 */
describe("DefaultHarness over a real local sandbox", () => {
  it.each(["default", "ai-sdk"] as const)(
    "executes the %s registry harness over a real local sandbox",
    async (harnessId) => {
      const workdir = await mkdtemp(join(tmpdir(), "oma-default-sandbox-"));
      const sandbox = new LocalSubprocessSandbox({ workdir });
      const userMessage: UserMessageEvent = {
        id: "event_default_user",
        type: "user.message",
        content: [{ type: "text", text: "Write the marker." }],
      };
      const events: SessionEvent[] = [userMessage];
      const model = createScriptedLanguageModel([
        streamStep([
          ...toolCallChunks({
            id: "tool_default_write",
            toolName: "write_marker",
            inputDeltas: ["{\"text\":", "\"default-ok\"}"],
          }),
          finishChunk("tool-calls"),
        ]),
        streamStep([
          ...textChunks("message_default_final", ["Marker ", "written."]),
          finishChunk("stop"),
        ]),
      ], { provider: "openma-e2e-mock", modelId: "default-sandbox-model" });

      const runtime = {
        history: {
          getEvents: () => events,
          getMessages: () => [],
          append: (event: SessionEvent) => events.push(event),
        },
        sandbox,
        broadcast: (event: SessionEvent) => events.push(event),
        broadcastStreamStart: vi.fn(async () => {}),
        broadcastChunk: vi.fn(async () => {}),
        broadcastStreamEnd: vi.fn(async () => {}),
        broadcastThinkingStart: vi.fn(async () => {}),
        broadcastThinkingChunk: vi.fn(async () => {}),
        broadcastThinkingEnd: vi.fn(async () => {}),
        broadcastToolInputStart: vi.fn(async () => {}),
        broadcastToolInputChunk: vi.fn(async () => {}),
        broadcastToolInputEnd: vi.fn(async () => {}),
        reportUsage: vi.fn(async () => {}),
        pendingConfirmations: [],
      } as unknown as HarnessRuntime;

      const tools = {
        write_marker: tool({
          description: "Write a marker into the sandbox workspace.",
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => {
            await sandbox.writeFile("/workspace/default-harness.txt", text);
            return "sandbox write complete";
          },
        }),
      };
      const agent: AgentConfig = {
        id: "agent_default_sandbox",
        name: "Default sandbox agent",
        model: "default-sandbox-model",
        system: "Use the write_marker tool.",
        tools: [],
        harness: harnessId,
        version: 1,
        created_at: "2026-09-04T00:00:00.000Z",
      };

      try {
        registerCoreHarnesses();
        await resolveHarness(harnessId).run({
          agent,
          userMessage,
          session_id: "session_default_sandbox",
          tools,
          model: model.model,
          systemPrompt: agent.system,
          env: { ANTHROPIC_API_KEY: "mocked-by-scripted-provider" },
          runtime,
        });

        await expect(sandbox.readFile("/workspace/default-harness.txt"))
          .resolves.toBe("default-ok");
        expect(events).toContainEqual(expect.objectContaining({
          type: "agent.custom_tool_use",
          id: "tool_default_write",
          name: "write_marker",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "agent.tool_result",
          tool_use_id: "tool_default_write",
          content: "sandbox write complete",
        }));
        expect(events).toContainEqual(expect.objectContaining({
          type: "agent.message",
          content: [{ type: "text", text: "Marker written." }],
        }));
        expect(model.callCount).toBe(2);
        model.assertExhausted();
      } finally {
        await sandbox.destroy();
      }
    },
  );
});
