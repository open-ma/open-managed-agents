import { jsonSchema, tool, type ToolSet } from "ai";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { readManagedSessionMappingMetadata, type ResourceSecretSealer } from "@open-managed-agents/openai-agents-compat";
import type { ManagedNodeSubagentControl } from "./lib/node-managed-subagents.js";

/** Read the already sealed native Session configuration, without a second registry. */
export async function nodeOpenAISubagentPolicy(session: Session, secrets: ResourceSecretSealer) {
  const saved = await readManagedSessionMappingMetadata(session, secrets);
  return saved
    ? { enabled: saved.agent.multi_agent?.enabled === true, maxConcurrentSubagents: saved.agent.multi_agent?.max_concurrent_subagents ?? 6 }
    : { enabled: (session.agent.multiagent?.agents.length ?? 0) > 0, maxConcurrentSubagents: 6 };
}

/** OpenAI children share the environment and configured MCP/search tools. Function
 * calls require the root client's result channel, so they are excluded here. */
export function openAISubagentSession(session: Session, request: { name?: string; instructions?: string }): Session {
  return {
    ...session,
    agent: {
      ...session.agent,
      name: request.name ?? "Subagent",
      system: request.instructions ?? "Complete the delegated task in your own conversation and report the result to the coordinating agent.",
      tools: session.agent.tools.filter(item => item.type !== "custom"),
    },
  };
}

/** Model-facing tools execute existing native thread operations. Their persisted
 * calls are projected into the official coordination item types by compat. */
export function buildOpenAISubagentTools(control: ManagedNodeSubagentControl): ToolSet {
  const id = { type: "string" as const, minLength: 1 };
  const object = <T>(properties: Record<string, unknown>, required: string[]) => jsonSchema<T>({ type: "object", properties, required, additionalProperties: false });
  const state = (value: Awaited<ReturnType<ManagedNodeSubagentControl["create"]>>) => ({ id: value.threadId, status: value.status, ...(value.output !== undefined && { output: value.output }) });
  const tools: ToolSet = {
    create_subagent: tool({
      description: "Create an independent subagent sharing this session's environment. Supply its task as message. Returns the subagent id immediately; use wait_for_subagents to obtain results.",
      inputSchema: object<{ name?: string; instructions?: string; message: string }>({ name: { type: "string" }, instructions: { type: "string" }, message: id }, ["message"]),
      execute: async (input, options) => state(await control.create({ ...input, parentToolUseId: options.toolCallId })),
    }),
    send_subagent_input: tool({
      description: "Send a follow-up task to an existing subagent, retaining its independent history.",
      inputSchema: object<{ id: string; message: string }>({ id, message: id }, ["id", "message"]),
      execute: async input => state(await control.send({ threadId: input.id, message: input.message })),
    }),
    wait_for_subagents: tool({
      description: "Wait until one of the specified subagents stops running or the timeout expires. Inspect returned statuses and outputs before proceeding.",
      inputSchema: object<{ ids: string[]; timeout_ms?: number }>({ ids: { type: "array", items: id, minItems: 1 }, timeout_ms: { type: "integer", minimum: 0, maximum: 300000 } }, ["ids"]),
      execute: async input => {
        const result = await control.wait({ threadIds: input.ids, timeoutMs: input.timeout_ms });
        return { subagents: result.subagents.map(state), timed_out: result.timedOut };
      },
    }),
    interrupt_subagent: tool({
      description: "Interrupt only the specified subagent's current task. Its history remains available for follow-up work.",
      inputSchema: object<{ id: string }>({ id }, ["id"]),
      execute: async input => state(await control.interrupt({ threadId: input.id })),
    }),
    close_subagent: tool({
      description: "Close a subagent, stopping its current work and releasing its concurrency slot. Its history remains available.",
      inputSchema: object<{ id: string }>({ id }, ["id"]),
      execute: async input => state(await control.close({ threadId: input.id })),
    }),
    resume_subagent: tool({
      description: "Reopen a closed subagent with its existing history. Optionally provide a new task.",
      inputSchema: object<{ id: string; message?: string }>({ id, message: { type: "string" } }, ["id"]),
      execute: async input => state(await control.resume({ threadId: input.id, message: input.message })),
    }),
  };
  for (const definition of Object.values(tools)) definition.metadata = { ...definition.metadata, openmaBuiltin: true };
  return tools;
}
