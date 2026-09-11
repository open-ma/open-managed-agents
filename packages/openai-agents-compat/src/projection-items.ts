import type { AgentSessionItem } from 'openai/resources/beta/agents/agents';
import type { ManagedProjectionEvent } from './projection';

export const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
export function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap(part => typeof asRecord(part).text === 'string' ? [asRecord(part).text as string] : []);
  return text.length > 0 ? text.join('\n') : null;
}
export type ProjectedCallKind = 'custom' | 'function' | 'command' | 'mcp' | 'webSearch' | 'coordination';
export function toolItem(event: ManagedProjectionEvent, id: string, turnId: string, agentId: string): { item: AgentSessionItem; kind: ProjectedCallKind } | null {
  const input = event.input ?? {};
  const args = asRecord(input);
  const name = string(event.name);
  if (!name) return null;
  if (event.type === 'agent.mcp_tool_use') {
    const server = string(event.mcpServerName ?? event.mcp_server_name);
    if (!server) return null;
    return { kind: 'mcp', item: { id, type: 'mcp_call', turn_id: turnId, name, arguments: input, server_label: server, status: 'in_progress', output: null, error: null } };
  }
  if (event.type !== 'agent.custom_tool_use' && (name === 'bash' || name === 'shell' || name === 'exec_command') && typeof args.command === 'string') return { kind: 'command', item: { id, type: 'command_execution', turn_id: turnId, command: args.command, cwd: string(args.cwd), duration_ms: null, exit_code: null, output: null, status: 'in_progress' } };
  if (event.type !== 'agent.custom_tool_use' && name === 'web_search') {
    const query = string(args.query ?? args.q);
    return { kind: 'webSearch', item: { id, type: 'web_search_call', turn_id: turnId, action: query === null ? null : { type: 'search', query, queries: null }, status: 'in_progress' } };
  }
  const sender = string(args.sender_agent_id) ?? agentId;
  const recipient = string(args.recipient_agent_id ?? args.agent_id ?? args.id ?? args.target);
  if (event.type !== 'agent.custom_tool_use') {
    const control = name.replace(/^(?:openma_)+/, '');
    const content = contentText(args.content ?? args.message ?? args.instructions);
    if (control === 'create_subagent') return { kind: 'coordination', item: { id, type: 'create_subagent_call', turn_id: turnId, agent_id: agentId, content: content === null ? [] : [{ type: 'output_text', text: content }], model: string(args.model), reasoning_effort: string(args.reasoning_effort), status: 'in_progress' } };
    if (control === 'send_subagent_input' && recipient) return { kind: 'coordination', item: { id, type: 'send_subagent_input_call', turn_id: turnId, sender_agent_id: sender, recipient_agent_id: recipient, content: content === null ? [] : [{ type: 'output_text', text: content }], status: 'in_progress' } };
    const recipients = args.recipient_agent_ids ?? args.agent_ids ?? args.ids;
    if (control === 'wait_for_subagents' && Array.isArray(recipients) && recipients.every(value => typeof value === 'string')) return { kind: 'coordination', item: { id, type: 'wait_for_subagents_call', turn_id: turnId, sender_agent_id: sender, recipient_agent_ids: recipients, status: 'in_progress' } };
    if ((control === 'interrupt_subagent' || control === 'close_subagent' || control === 'resume_subagent') && recipient) return { kind: 'coordination', item: { id, type: `${control}_call`, turn_id: turnId, sender_agent_id: sender, recipient_agent_id: recipient, status: 'in_progress' } };
  }
  return { kind: event.type === 'agent.custom_tool_use' ? 'custom' : 'function', item: { id, type: 'function_call', turn_id: turnId, call_id: id, name, arguments: input, status: 'in_progress' } };
}

/** Decode only explicit execution facts; text success never implies exit_code=0. */
export function applyToolResult(item: AgentSessionItem, event: ManagedProjectionEvent): AgentSessionItem {
  const failed = (event.isError ?? event.is_error) === true;
  if (item.type === 'command_execution') {
    const text = contentText(event.content);
    let facts = asRecord(event.output ?? event.result);
    if (Object.keys(facts).length === 0 && text !== null) { try { facts = asRecord(JSON.parse(text)); } catch { /* Output is ordinary text. */ } }
    const explicitOutput = string(facts.output);
    const stdout = string(facts.stdout);
    const stderr = string(facts.stderr);
    const output = explicitOutput ?? (stdout !== null || stderr !== null ? [stdout, stderr].filter(value => value !== null && value !== '').join('\n') : text);
    const exit = facts.exit_code ?? facts.exitCode ?? event.exit_code ?? event.exitCode;
    const duration = facts.duration_ms ?? facts.durationMs ?? event.duration_ms ?? event.durationMs;
    return { ...item, status: failed ? 'failed' : 'completed', output, exit_code: typeof exit === 'number' && Number.isInteger(exit) ? exit : null, duration_ms: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null };
  }
  if (item.type === 'mcp_call') return { ...item, status: failed ? 'failed' : 'completed', output: failed ? null : event.content ?? event.output ?? null, error: failed ? event.content ?? event.error ?? null : null };
  if (item.type === 'web_search_call') return { ...item, status: failed ? 'incomplete' : 'completed' };
  if ('status' in item) return { ...item, status: failed ? 'failed' : 'completed' } as AgentSessionItem;
  return item;
}
