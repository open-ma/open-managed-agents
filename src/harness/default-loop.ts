import { generateText } from "ai";
import type { HarnessInterface, HarnessContext } from "./interface";
import type { SessionEvent } from "../types";
import { resolveModel } from "./provider";
import { buildTools, buildMemoryTools } from "./tools";
import { resolveSkills } from "./skills";
import { SummarizeCompaction } from "./compaction";

const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);
const isBuiltinTool = (name: string) =>
  BUILTIN_TOOLS.has(name) || name.startsWith("mcp_") || name.startsWith("call_agent_") || name.startsWith("memory_");

export class DefaultHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime } = ctx;

    // 1. Rebuild conversation from event log
    const messages = runtime.history.getMessages();
    messages.push({
      role: "user",
      content: userMessage.content.map((b) => ({ type: "text" as const, text: b.text })),
    });

    // 2. Build tools from agent config
    const tools = await buildTools(agent, runtime.sandbox, ctx.env);

    // 2b. Inject memory tools if session has memory stores
    if (ctx.env.memoryStoreIds?.length && ctx.env.CONFIG_KV) {
      const memTools = buildMemoryTools(ctx.env.memoryStoreIds, ctx.env.CONFIG_KV);
      Object.assign(tools, memTools);
    }

    // 3. Resolve model
    const modelId = typeof agent.model === "string" ? agent.model : agent.model.id;
    const model = resolveModel(modelId, ctx.env.ANTHROPIC_API_KEY, ctx.env.ANTHROPIC_BASE_URL);

    // 4. Resolve skills and build system prompt
    let systemPrompt = agent.system;
    if (agent.skills?.length) {
      const skills = resolveSkills(agent.skills);
      const additions = skills.map(s => s.system_prompt_addition).filter(Boolean);
      if (additions.length) {
        systemPrompt += "\n\n" + additions.join("\n\n");
      }
    }

    // 5. Compact messages if conversation is too long
    let finalMessages = messages;
    const compaction = new SummarizeCompaction();
    if (compaction.shouldCompact(messages)) {
      const originalCount = messages.length;
      finalMessages = await compaction.compact(messages, model);
      // Emit compaction event
      runtime.broadcast({
        type: "agent.thread_context_compacted",
        original_message_count: originalCount,
        compacted_message_count: finalMessages.length,
      });
    }

    // 6. Emit span event: model request start
    runtime.broadcast({ type: "span.model_request_start", model: modelId });

    // 7. Run agent loop
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: finalMessages,
      tools,
      maxSteps: 25,

      onStepFinish: async ({ text, toolCalls, toolResults, reasoning }) => {
        // Emit thinking event if extended thinking was used
        if (reasoning) {
          const thinkingEvent: SessionEvent = { type: "agent.thinking" };
          runtime.broadcast(thinkingEvent);
        }

        // Emit text response
        if (text) {
          const msgEvent: SessionEvent = {
            type: "agent.message",
            content: [{ type: "text", text }],
          };
          runtime.broadcast(msgEvent);
        }

        // Emit tool calls and results
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];

          // Emit thread_message_sent before call_agent_* tool use
          if (call.toolName.startsWith("call_agent_")) {
            runtime.broadcast({
              type: "agent.thread_message_sent",
              thread_id: call.toolCallId,
              content: [{ type: "text", text: String((call.args as Record<string, unknown>).message || "") }],
            });
          }

          // Distinguish built-in vs custom tool use events
          if (isBuiltinTool(call.toolName)) {
            // Check if tool requires confirmation (always_ask — no execute function)
            const hasExecute = tools[call.toolName] && typeof tools[call.toolName].execute === "function";
            const toolUseEvent: SessionEvent = {
              type: "agent.tool_use",
              id: call.toolCallId,
              name: call.toolName,
              input: call.args as Record<string, unknown>,
            };
            if (!hasExecute) {
              (toolUseEvent as import("../types").AgentToolUseEvent).evaluated_permission = "ask";
            }
            runtime.broadcast(toolUseEvent);
          } else {
            const customToolUseEvent: SessionEvent = {
              type: "agent.custom_tool_use",
              id: call.toolCallId,
              name: call.toolName,
              input: call.args as Record<string, unknown>,
            };
            runtime.broadcast(customToolUseEvent);
          }

          // Find matching result by toolCallId (not index — some tools may lack execute)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tr = (toolResults as any[])?.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (r: any) => r.toolCallId === call.toolCallId
          );
          if (tr) {
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: call.toolCallId,
              content:
                typeof tr.result === "string"
                  ? tr.result
                  : JSON.stringify(tr.result),
            };
            runtime.broadcast(toolResultEvent);
          }

          // Emit thread_message_received after call_agent_* tool result
          if (call.toolName.startsWith("call_agent_") && tr) {
            runtime.broadcast({
              type: "agent.thread_message_received",
              thread_id: call.toolCallId,
              content: [{ type: "text", text: typeof tr.result === "string" ? tr.result : "" }],
            });
          }
        }
      },
    });

    // 8. Detect pending tool confirmations (always_ask tools called without execute)
    if (result.toolCalls?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resultedIds = new Set((result.toolResults as any[])?.map((r: any) => r.toolCallId) ?? []);
      const pending = result.toolCalls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => !resultedIds.has(c.toolCallId))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.toolCallId);
      if (pending.length && ctx.runtime.pendingConfirmations) {
        ctx.runtime.pendingConfirmations.push(...pending);
      }
    }

    // 9. Emit span event: model request end
    runtime.broadcast({
      type: "span.model_request_end",
      model: modelId,
      model_usage: result.usage ? {
        input_tokens: result.usage.promptTokens,
        output_tokens: result.usage.completionTokens,
      } : undefined,
    });

    // 10. Report token usage
    if (result.usage && runtime.reportUsage) {
      await runtime.reportUsage(
        result.usage.promptTokens,
        result.usage.completionTokens
      );
    }
  }
}
