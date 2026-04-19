import { generateText, stepCountIs } from "ai";
import type { HarnessInterface, HarnessContext } from "./interface";
import type { SessionEvent } from "@open-managed-agents/shared";
import { SummarizeCompaction } from "./compaction";

const BUILTIN_TOOLS = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);
const isMcpTool = (name: string) => name.startsWith("mcp_");
const isBuiltinTool = (name: string) =>
  BUILTIN_TOOLS.has(name) || isMcpTool(name) || name.startsWith("call_agent_") || name.startsWith("memory_");

// LLM call resilience settings (inspired by Claude Code)
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY = 2000;   // 2s, doubles each retry (capped at 30s)
const API_TIMEOUT_MS = 300000;   // 5 minutes per generateText call

/**
 * Retry an async function with exponential backoff + jitter.
 */
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  maxRetries: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (parentSignal?.aborted) throw new Error("Aborted");

    // Create a timeout signal for this attempt
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      // Don't retry on user abort
      if (parentSignal?.aborted) throw err;

      // Don't retry on non-transient errors
      const msg = describeError(err);
      const isTransient = /timeout|abort|429|529|5\d\d|ECONNRESET|overloaded|rate.limit|fetch failed/i.test(msg);

      console.log(`[retry] attempt ${attempt + 1}/${maxRetries + 1} failed: ${msg.slice(0, 150)} transient=${isTransient}`);

      if (!isTransient) throw err;

      // Don't retry on last attempt
      if (attempt >= maxRetries) break;

      // Exponential backoff with jitter, capped at 30s
      const delay = Math.min(30000, BASE_RETRY_DELAY * Math.pow(2, attempt)) * (0.75 + Math.random() * 0.5);
      console.log(`[retry] waiting ${Math.round(delay)}ms before attempt ${attempt + 2}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Extract a meaningful error description. Handles cases where err.message
 * is empty (e.g. network failures, non-standard API errors).
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message;
    // Empty message — include name, cause, or status code if available
    const parts: string[] = [err.name || "Error"];
    if ("cause" in err && err.cause) parts.push(`cause: ${String(err.cause)}`);
    if ("status" in err) parts.push(`status: ${(err as any).status}`);
    if ("statusCode" in err) parts.push(`statusCode: ${(err as any).statusCode}`);
    if ("url" in err) parts.push(`url: ${(err as any).url}`);
    return parts.join(", ");
  }
  return String(err) || "Unknown error";
}

/**
 * Extract the MCP server name from a tool name like "mcp_github_call" or "mcp_github_list_tools".
 */
function extractMcpServerName(toolName: string): string {
  // mcp_{server_name}_{call|list_tools}
  const withoutPrefix = toolName.slice(4); // Remove "mcp_"
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  // Handle _list_tools (two underscores)
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  if (lastUnderscore > 0) {
    return withoutPrefix.slice(0, lastUnderscore);
  }
  return withoutPrefix;
}

export class DefaultHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, userMessage, runtime, tools, model, systemPrompt } = ctx;

    // --- Harness decides HOW to deliver context to the model ---

    // 1. Rebuild conversation from event log
    // The current userMessage is already appended to history by SessionDO,
    // so getMessages() includes it. No need to push again.
    const messages = runtime.history.getMessages();

    // Cache strategy: mark last historical message as cache breakpoint.
    // Everything before this point is stable and cached by Anthropic API,
    // saving tokens on multi-turn conversations.
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      (lastMsg as any).providerMetadata = {
        anthropic: { cacheControl: { type: "ephemeral" } },
      };
    }

    // 2. Compaction strategy: summarize middle section when context is too long
    let finalMessages = messages;
    const compaction = new SummarizeCompaction();
    if (compaction.shouldCompact(messages)) {
      const originalCount = messages.length;
      finalMessages = await compaction.compact(messages, model);
      runtime.broadcast({
        type: "agent.thread_context_compacted",
        original_message_count: originalCount,
        compacted_message_count: finalMessages.length,
      });
    }

    // 3. Emit span event: model request start
    const modelId = typeof agent.model === "string" ? agent.model : agent.model.id;
    runtime.broadcast({ type: "span.model_request_start", model: modelId });

    // 7. Run agent loop with retry + timeout + prompt caching
    //
    // Anthropic prompt caching: @ai-sdk/anthropic has cacheControl enabled
    // by default. We mark the system prompt for caching via providerOptions,
    // which avoids re-processing the same system prompt across turns.
    const result = await withRetry((signal) => generateText({
      model,
      system: systemPrompt,
      messages: finalMessages,
      tools,
      stopWhen: stepCountIs(100),
      abortSignal: signal,

      onStepFinish: async ({ text, toolCalls, toolResults, reasoning }) => {
        // Emit one agent.thinking event per reasoning block, preserving the
        // text + provider metadata (signature for Claude, opaque ids for other
        // providers). history.ts replays these as ReasoningPart in subsequent
        // steps so the model sees its own prior chain-of-thought.
        if (reasoning && Array.isArray(reasoning)) {
          for (const r of reasoning) {
            const thinkingEvent: SessionEvent = {
              type: "agent.thinking",
              text: r.text,
              providerOptions: r.providerOptions as Record<string, unknown> | undefined,
            };
            runtime.broadcast(thinkingEvent);
          }
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

          // AI SDK v6 uses `input` instead of `args` for tool call parameters
          const callInput = (call as any).input as Record<string, unknown> || {};

          // Emit thread_message_sent before call_agent_* tool use
          if (call.toolName.startsWith("call_agent_")) {
            runtime.broadcast({
              type: "agent.thread_message_sent",
              to_thread_id: call.toolCallId,
              content: [{ type: "text", text: String(callInput.message || "") }],
            });
          }

          // Distinguish MCP vs built-in vs custom tool use events
          if (isMcpTool(call.toolName)) {
            const mcpToolUseEvent: SessionEvent = {
              type: "agent.mcp_tool_use",
              id: call.toolCallId,
              mcp_server_name: extractMcpServerName(call.toolName),
              name: call.toolName,
              input: callInput,
            };
            runtime.broadcast(mcpToolUseEvent);
          } else if (isBuiltinTool(call.toolName)) {
            const hasExecute = tools[call.toolName] && typeof tools[call.toolName].execute === "function";
            const toolUseEvent: SessionEvent = {
              type: "agent.tool_use",
              id: call.toolCallId,
              name: call.toolName,
              input: callInput,
            };
            if (!hasExecute) {
              (toolUseEvent as import("@open-managed-agents/shared").AgentToolUseEvent).evaluated_permission = "ask";
            }
            runtime.broadcast(toolUseEvent);
          } else {
            const customToolUseEvent: SessionEvent = {
              type: "agent.custom_tool_use",
              id: call.toolCallId,
              name: call.toolName,
              input: callInput,
            };
            runtime.broadcast(customToolUseEvent);
          }

          // Find matching result by toolCallId
          // AI SDK v6: toolResults use `output` instead of `result`
          const tr = (toolResults as any[])?.find(
            (r: any) => r.toolCallId === call.toolCallId
          );
          if (tr) {
            const trOutput = tr.output ?? tr.result;
            // Multimodal pass-through: if a tool returned a single ContentBlock
            // (e.g. Read tool returning an image), wrap it in an array so the
            // event content is ContentBlock[] rather than JSON-stringified.
            const isContentBlock =
              trOutput && typeof trOutput === "object" && "type" in trOutput &&
              ((trOutput.type === "image" && "source" in trOutput) ||
               (trOutput.type === "text" && "text" in trOutput) ||
               (trOutput.type === "document" && "source" in trOutput));
            const isContentBlockArray =
              Array.isArray(trOutput) && trOutput.every(
                (b) => b && typeof b === "object" && "type" in b,
              );
            const eventContent = isContentBlock
              ? [trOutput]
              : isContentBlockArray
                ? trOutput
                : typeof trOutput === "string"
                  ? trOutput
                  : JSON.stringify(trOutput);

            if (isMcpTool(call.toolName)) {
              const mcpResultEvent: SessionEvent = {
                type: "agent.mcp_tool_result",
                mcp_tool_use_id: call.toolCallId,
                content: typeof eventContent === "string" ? eventContent : JSON.stringify(eventContent),
              };
              runtime.broadcast(mcpResultEvent);
            } else {
              const toolResultEvent: SessionEvent = {
                type: "agent.tool_result",
                tool_use_id: call.toolCallId,
                content: eventContent,
              };
              runtime.broadcast(toolResultEvent);
            }
          }

          if (call.toolName.startsWith("call_agent_") && tr) {
            const trOutput = tr.output ?? tr.result;
            runtime.broadcast({
              type: "agent.thread_message_received",
              from_thread_id: call.toolCallId,
              content: [{ type: "text", text: typeof trOutput === "string" ? trOutput : "" }],
            });
          }
        }
      },
    }), MAX_RETRIES, runtime.abortSignal);


    // 8. Detect pending tool confirmations and custom tool results
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
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
      } : undefined,
      finish_reason: result.finishReason,
      final_text_length: typeof result.text === "string" ? result.text.length : 0,
    });

    // 10. Report token usage
    if (result.usage && runtime.reportUsage) {
      await runtime.reportUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0
      );
    }
  }
}
