import { describe, expect, it } from 'vitest';
import { validateOpenAIAgentsSchema } from '@open-managed-agents/openai-agents-api';
import { acceptInput, applyManagedEvents, createProjectionState } from '../src/projection';
const fresh = () => acceptInput(createProjectionState({ sessionId: 's', agentId: 'a', createdAt: 1 }), [{ id: 'input', type: 'user.message', content: [{ type: 'text', text: 'Start' }] }], { observedAt: 2 }).state;
const apply = (events: any[], state = fresh(), extra = {}) => {
  const result = applyManagedEvents(state, events, { observedAt: 3, ...extra });
  for (const event of result.events) expect(validateOpenAIAgentsSchema(event, 'agents.AgentSessionEvent'), JSON.stringify(event)).toEqual({ success: true });
  return result;
};

describe('Factual tool and subagent projections', () => {
  it('projects all native subagent controls as the official coordination items', () => {
    const result = apply([
      { id: 'create', type: 'agent.tool_use', name: 'create_subagent', input: { name: 'Researcher', message: 'Find facts', model: 'gpt-5', reasoning_effort: 'high' } },
      { id: 'created', type: 'agent.tool_result', toolUseId: 'create', content: [{ type: 'text', text: '{"id":"child"}' }] },
      { id: 'send', type: 'agent.tool_use', name: 'send_subagent_input', input: { id: 'child', message: 'Check sources' } },
      { id: 'wait', type: 'agent.tool_use', name: 'wait_for_subagents', input: { ids: ['child'] } },
      { id: 'interrupt', type: 'agent.tool_use', name: 'interrupt_subagent', input: { id: 'child' } },
      { id: 'close', type: 'agent.tool_use', name: 'close_subagent', input: { id: 'child' } },
      { id: 'resume', type: 'agent.tool_use', name: 'resume_subagent', input: { id: 'child' } },
      { id: 'resumed', type: 'agent.tool_result', toolUseId: 'resume', content: [{ type: 'text', text: 'Resumed' }] },
    ]);
    expect(result.state.items.create).toMatchObject({ type: 'create_subagent_call', agent_id: 'a', content: [{ type: 'output_text', text: 'Find facts' }], model: 'gpt-5', reasoning_effort: 'high', status: 'completed' });
    expect(result.state.items.send).toMatchObject({ type: 'send_subagent_input_call', sender_agent_id: 'a', recipient_agent_id: 'child', content: [{ type: 'output_text', text: 'Check sources' }] });
    expect(result.state.items.wait).toMatchObject({ type: 'wait_for_subagents_call', sender_agent_id: 'a', recipient_agent_ids: ['child'] });
    expect(result.state.items.interrupt).toMatchObject({ type: 'interrupt_subagent_call', recipient_agent_id: 'child' });
    expect(result.state.items.close).toMatchObject({ type: 'close_subagent_call', recipient_agent_id: 'child' });
    expect(result.state.items.resume).toMatchObject({ type: 'resume_subagent_call', recipient_agent_id: 'child', status: 'completed' });
    expect(result.state.items.created).toBeUndefined();
    expect(result.state.requiredActions).toEqual([]);
  });

  it('does not mistake a client function named after a coordination tool for a native control', () => {
    const result = apply([{ id: 'custom', type: 'agent.custom_tool_use', name: 'interrupt_subagent', input: { recipient_agent_id: 'child' } }]);
    expect(result.state.items.custom).toMatchObject({ type: 'function_call', name: 'interrupt_subagent' });
    expect(result.state.requiredActions).toMatchObject([{ type: 'function_call', call_id: 'custom' }]);
  });

  it('recognizes a collision-aliased native subagent control without renaming a client function', () => {
    const result = apply([
      { id: 'native', type: 'agent.tool_use', name: 'openma_openma_create_subagent', input: { message: 'Task' } },
      { id: 'custom', type: 'agent.custom_tool_use', name: 'openma_create_subagent', input: { message: 'User function' } },
    ]);
    expect(result.state.items.native).toMatchObject({ type: 'create_subagent_call', content: [{ type: 'output_text', text: 'Task' }] });
    expect(result.state.items.custom).toMatchObject({ type: 'function_call', name: 'openma_create_subagent' });
    expect(result.state.requiredActions).toMatchObject([{ call_id: 'custom', name: 'openma_create_subagent' }]);
  });

  it('projects common agent work items and nested output into child turns while leaving the parent running', () => {
    const canonical = (event_id: string, type: string, data: unknown, envelope = {}) => ({ schema_version: 'oma.event.v1', event_id, type, session_id: 's', occurred_at: '2026-09-11T00:00:00Z', source: { kind: 'harness', harness: 'acp' }, data, ...envelope });
    const result = apply([
      { id: 'root_run', type: 'session.status_running' },
      { id: 'delegate', type: 'agent.tool_use', name: 'create_subagent', input: { message: 'Find facts' } },
      canonical('child_start', 'work_item.started', { kind: 'agent', title: 'Researcher' }, { work_item_id: 'child', parent_id: 'delegate' }),
      canonical('child_text', 'agent.message', { text: 'Facts' }, { parent_id: 'delegate' }),
      canonical('child_complete', 'work_item.completed', { result: 'Facts' }, { work_item_id: 'child', parent_id: 'delegate' }),
      canonical('late_progress', 'work_item.progress', { output: 'Late' }, { work_item_id: 'child', parent_id: 'delegate' }),
      canonical('bash_start', 'work_item.started', { kind: 'bash', title: 'Build' }, { work_item_id: 'bash' }),
    ]);
    expect(result.state.subagentOrder).toEqual(['child']);
    expect(result.state.subagents.child).toMatchObject({ parent_agent_id: 'a', name: 'Researcher', status: 'active', closed_at: null, opened_at: 1789084800 });
    expect(result.state.turnOrder).toHaveLength(2);
    expect(result.state.turns[result.state.turnOrder[0]].status).toBe('in_progress');
    expect(result.state.turns[result.state.turnOrder[1]]).toMatchObject({ subagent_id: 'child', status: 'completed' });
    expect(result.state.items.child_text).toMatchObject({ turn_id: result.state.turnOrder[1], content: [{ type: 'output_text', text: 'Facts' }], status: 'completed' });
    expect(result.state.unresolved).toEqual([]);
    const replay = apply([
      canonical('child_start', 'work_item.started', { kind: 'agent', title: 'Researcher' }, { work_item_id: 'child', parent_id: 'delegate' }),
      canonical('child_text', 'agent.message', { text: 'Facts' }, { parent_id: 'delegate' }),
    ], JSON.parse(JSON.stringify(result.state)));
    expect(replay.events).toEqual([]);
    expect(replay.state.turnOrder).toHaveLength(2);
  });

  it('keeps a stable public child identity when common refines its provisional work item ID', () => {
    const canonical = (event_id: string, type: string, data: unknown, envelope = {}) => ({ schema_version: 'oma.event.v1', event_id, type, session_id: 's', occurred_at: '2026-09-11T00:00:00Z', source: { kind: 'harness' }, data, ...envelope });
    const result = apply([
      canonical('start', 'work_item.started', { kind: 'agent' }, { work_item_id: 'provisional' }),
      canonical('identify', 'work_item.reidentified', { previous_work_item_id: 'provisional' }, { work_item_id: 'real-child' }),
      canonical('message', 'agent.message', { text: 'Result' }, { session_thread_id: 'real-child' }),
      canonical('complete', 'work_item.completed', {}, { work_item_id: 'real-child' }),
    ]);
    expect(result.state.subagentOrder).toEqual(['provisional']);
    expect(result.state.turnOrder).toHaveLength(2);
    expect(result.state.items.message.turn_id).toBe(result.state.turnOrder[1]);
    expect(result.state.turns[result.state.turnOrder[1]]).toMatchObject({ subagent_id: 'provisional', status: 'completed' });
  });

  it('preserves common nested transcript chunks and tool identities through child completion', () => {
    const canonical = (event_id: string, type: string, data: unknown) => ({ schema_version: 'oma.event.v1', event_id, type, session_id: 's', session_thread_id: 'child', occurred_at: '2026-09-11T00:00:00Z', source: { kind: 'harness' }, data });
    const result = apply([
      { id: 'child_open', type: 'session.thread_created', session_thread_id: 'child' },
      { id: 'child_run', type: 'session.thread_status_running', session_thread_id: 'child' },
      canonical('text_one', 'agent.message_chunk', { message_id: 'message', text: 'A' }),
      canonical('text_two', 'agent.message_chunk', { message_id: 'message', text: 'B' }),
      canonical('read_start', 'tool.started', { tool_call_id: 'read', tool_name: 'read', raw_input: { path: '/workspace/facts' } }),
      canonical('read_finish', 'tool.completed', { tool_call_id: 'read', raw_output: 'Facts' }),
      { id: 'child_done', type: 'session.thread_status_idle', session_thread_id: 'child', stop_reason: { type: 'end_turn' } },
    ]);
    expect(result.state.items.message).toMatchObject({ content: [{ type: 'output_text', text: 'AB' }], status: 'completed', turn_id: result.state.turnOrder[1] });
    expect(result.state.items.read).toMatchObject({ type: 'function_call', name: 'read', arguments: { path: '/workspace/facts' }, status: 'completed', turn_id: result.state.turnOrder[1] });
    expect(result.state.items.read_finish).toMatchObject({ type: 'function_call_output', call_id: 'read', output: [{ type: 'input_text', text: 'Facts' }], turn_id: result.state.turnOrder[1] });
    expect(result.state.requiredActions).toEqual([]);
    expect(result.state.unresolved).toEqual([]);
  });

  it('separates interrupted work from closed child lifetime and resumes with the original opened time', () => {
    const opened = apply([
      { id: 'open', type: 'session.thread_created', session_thread_id: 'child', processed_at: 10 },
      { id: 'run', type: 'session.thread_status_running', session_thread_id: 'child', processed_at: 11 },
      { schema_version: 'oma.event.v1', event_id: 'interrupt', type: 'work_item.cancelled', session_id: 's', work_item_id: 'child', occurred_at: '2026-09-11T00:00:00Z', source: { kind: 'harness' }, data: { kind: 'agent' } },
    ]);
    expect(opened.state.subagents.child).toMatchObject({ status: 'active', closed_at: null });
    expect(opened.state.turns[opened.state.turnOrder[1]].status).toBe('cancelled');
    const closed = apply([{ id: 'close', type: 'session.thread_status_terminated', session_thread_id: 'child', processed_at: 12 }], opened.state);
    const resumed = apply([
      { id: 'next_input', type: 'agent.thread_message_received', session_thread_id: 'child', from_session_thread_id: 'root', content: [{ type: 'text', text: 'Continue' }], processed_at: 13 },
      { id: 'resume', type: 'session.thread_status_running', session_thread_id: 'child', processed_at: 13 },
    ], closed.state);
    expect(resumed.state.subagents.child).toMatchObject({ opened_at: 10, status: 'active', closed_at: null });
    expect(resumed.state.turnOrder).toHaveLength(3);
    expect(resumed.state.turns[resumed.state.turnOrder[2]]).toMatchObject({ subagent_id: 'child', status: 'in_progress' });
    expect(resumed.events.filter(event => event.type === 'agent.session.subagent.active')).toHaveLength(1);
  });

  it('does not invent a child turn when a closed native subagent resumes without input', () => {
    const stopped = apply([
      { id: 'open', type: 'session.thread_created', session_thread_id: 'child' },
      { id: 'run', type: 'session.thread_status_running', session_thread_id: 'child' },
      { id: 'idle', type: 'session.thread_status_idle', session_thread_id: 'child', stopReason: { type: 'end_turn' }, interrupted: true },
      { id: 'close', type: 'session.thread_status_terminated', session_thread_id: 'child' },
    ]);
    expect(stopped.state.turns[stopped.state.turnOrder[1]].status).toBe('cancelled');
    const resumed = apply([{ id: 'resume', type: 'session.thread_status_running', session_thread_id: 'child' }], stopped.state);
    expect(resumed.state.subagents.child.status).toBe('active');
    expect(resumed.state.turnOrder).toHaveLength(2);
    expect(resumed.events.filter(event => event.type === 'agent.session.turn.created')).toEqual([]);
  });

  it('reactivates a closed child from the native idle resume fact without creating a turn', () => {
    const closed = apply([
      { id: 'open', type: 'session.thread_created', session_thread_id: 'child', processed_at: 10 },
      { id: 'close', type: 'session.thread_status_terminated', session_thread_id: 'child', processed_at: 11 },
    ]);
    const resumed = apply([{ id: 'reopen', type: 'session.thread_status_idle', session_thread_id: 'child', stop_reason: { type: 'end_turn' }, processed_at: 12 }], closed.state);
    expect(resumed.state.subagents.child).toMatchObject({ status: 'active', opened_at: 10, closed_at: null });
    expect(resumed.state.turnOrder).toEqual(closed.state.turnOrder);
    expect(resumed.events.filter(event => event.type === 'agent.session.subagent.active')).toHaveLength(1);
    expect(resumed.events.filter(event => event.type === 'agent.session.turn.created')).toEqual([]);
  });

  it('keeps shell command identity and actual exit/output facts without inventing success for plain text', () => {
    const result = apply([
      { id: 'bash_one', type: 'agent.tool_use', name: 'bash', input: { command: 'pwd', cwd: '/workspace' } },
      { id: 'bash_result', type: 'agent.tool_result', toolUseId: 'bash_one', content: [{ type: 'text', text: '{"stdout":"/workspace","stderr":"warn","exit_code":2,"duration_ms":42}' }], isError: true },
      { id: 'bash_two', type: 'agent.tool_use', name: 'bash', input: { command: 'custom-command' } },
      { id: 'bash_two_result', type: 'agent.tool_result', toolUseId: 'bash_two', content: [{ type: 'text', text: 'Some actual text' }] },
    ]);
    expect(result.state.items.bash_one).toMatchObject({ type: 'command_execution', command: 'pwd', cwd: '/workspace', exit_code: 2, duration_ms: 42, output: '/workspace\nwarn', status: 'failed' });
    expect(result.state.items.bash_two).toMatchObject({ type: 'command_execution', output: 'Some actual text', exit_code: null, duration_ms: null });
    expect(result.state.requiredActions).toEqual([]);
  });

  it('distinguishes MCP, web search, and server-executed functions from client-required functions', () => {
    const result = apply([
      { id: 'read_one', type: 'agent.tool_use', name: 'read', input: { path: '/workspace/a' } },
      { id: 'read_result', type: 'agent.tool_result', toolUseId: 'read_one', content: [{ type: 'text', text: 'file contents' }] },
      { id: 'mcp_one', type: 'agent.mcp_tool_use', mcpServerName: 'docs', name: 'search', input: { query: 'actual query' } },
      { id: 'mcp_result', type: 'agent.mcp_tool_result', mcpToolUseId: 'mcp_one', content: [{ type: 'text', text: 'actual result' }] },
      { id: 'search_one', type: 'agent.tool_use', name: 'web_search', input: { query: 'actual search' } },
      { id: 'search_result', type: 'agent.tool_result', toolUseId: 'search_one', content: [{ type: 'text', text: 'source result' }] },
    ]);
    expect(result.state.items.read_one).toMatchObject({ type: 'function_call', name: 'read', arguments: { path: '/workspace/a' }, status: 'completed' });
    expect(result.state.items.read_result).toMatchObject({ type: 'function_call_output', output: [{ type: 'input_text', text: 'file contents' }] });
    expect(result.state.items.mcp_one).toMatchObject({ type: 'mcp_call', server_label: 'docs', name: 'search', arguments: { query: 'actual query' }, output: [{ type: 'text', text: 'actual result' }], status: 'completed', error: null });
    expect(result.state.items.search_one).toMatchObject({ type: 'web_search_call', action: { type: 'search', query: 'actual search', queries: null }, status: 'completed' });
    expect(result.state.requiredActions).toEqual([]);
  });

  it('preserves live text identity, marks interrupted partial content incomplete, and never fabricates hidden thinking', () => {
    const first = apply([
      { type: 'agent.message_stream_start', message_id: 'message_live' },
      { type: 'agent.message_chunk', message_id: 'message_live', delta: '你' },
      { type: 'agent.message_chunk', message_id: 'message_live', delta: '好' },
      { id: 'reasoning_empty', type: 'agent.thinking' },
    ], fresh(), { batchId: 'batch_one' });
    expect(first.state.items.message_live).toMatchObject({ id: 'message_live', type: 'message', content: [{ type: 'output_text', text: '你好' }], status: 'in_progress' });
    expect(first.state.items.reasoning_empty).toMatchObject({ type: 'reasoning', summary: [] });
    expect(first.events.filter((e: any) => e.type === 'agent.session.turn.output_text.delta').map((e: any) => e.delta)).toEqual(['你', '好']);
    const second = apply([{ id: 'interrupt', type: 'user.interrupt' }, { id: 'message_live', type: 'agent.message', content: [{ type: 'text', text: '你好' }] }, { type: 'agent.message_stream_end', message_id: 'message_live', status: 'aborted' }], first.state, { batchId: 'batch_two' });
    expect(second.state.itemOrder.filter((id: string) => id === 'message_live')).toHaveLength(1);
    expect(second.state.items.message_live).toMatchObject({ status: 'incomplete' });
    const replay = apply([{ type: 'agent.message_stream_start', message_id: 'message_live' }, { type: 'agent.message_chunk', message_id: 'message_live', delta: '你' }, { type: 'agent.message_chunk', message_id: 'message_live', delta: '好' }, { id: 'reasoning_empty', type: 'agent.thinking' }], JSON.parse(JSON.stringify(second.state)), { batchId: 'batch_one' });
    expect(replay.events).toEqual([]);
    expect(replay.state.items.message_live).toMatchObject({ content: [{ type: 'output_text', text: '你好' }] });
  });

  it('keeps child turns and items isolated and preserves subagent lifecycle and real inter-agent messages', () => {
    const result = apply([
      { id: 'created_child', type: 'session.thread_created', sessionThreadId: 'child_one', agentName: 'Researcher' },
      { id: 'send_child', type: 'agent.thread_message_sent', toSessionThreadId: 'child_one', content: [{ type: 'text', text: 'Find facts' }] },
      { id: 'receive_child', type: 'agent.thread_message_received', sessionThreadId: 'child_one', fromSessionThreadId: 'root', content: [{ type: 'text', text: 'Find facts' }] },
      { id: 'run_child', type: 'session.thread_status_running', sessionThreadId: 'child_one' },
      { id: 'child_answer', type: 'agent.message', sessionThreadId: 'child_one', content: [{ type: 'text', text: 'Facts' }] },
      { id: 'child_done', type: 'session.thread_status_idle', sessionThreadId: 'child_one', stopReason: { type: 'end_turn' } },
    ]);
    expect(result.state.subagents.child_one).toMatchObject({ id: 'child_one', object: 'agent.session.subagent', name: 'Researcher', parent_agent_id: 'a', session_id: 's', status: 'active', closed_at: null, instructions: [{ type: 'output_text', text: 'Find facts' }] });
    const root = result.state.turns[result.state.turnOrder[0]];
    const child = result.state.turns[result.state.turnOrder[1]];
    expect(root.status).toBe('queued');
    expect(child).toMatchObject({ subagent_id: 'child_one', status: 'completed' });
    expect(result.state.items.child_answer.turn_id).toBe(child.id);
    expect(result.state.items.send_child).toMatchObject({ type: 'agent_message', sender_agent_id: 'a', recipient_agent_id: 'child_one', content: [{ type: 'output_text', text: 'Find facts' }] });
    expect(result.events.filter((e: any) => e.type === 'agent.session.turn.completed')).toMatchObject([{ turn: { subagent_id: 'child_one' } }]);
    const closed = apply([{ id: 'close_child', type: 'session.thread_status_terminated', sessionThreadId: 'child_one' }], result.state);
    expect(closed.state.subagents.child_one).toMatchObject({ status: 'closed', closed_at: 3 });
    expect(closed.events.some((e: any) => e.type === 'agent.session.subagent.closed')).toBe(true);
  });

  it('uses execution-to-input linkage for late output instead of moving it into a newer turn', () => {
    const first = apply([{ id: 'start1', type: 'session.status_running' }, { id: 'done1', type: 'session.status_idle', stopReason: { type: 'end_turn' } }], fresh(), { executionId: 'input' }).state;
    const second = acceptInput(first, [{ id: 'new_input', type: 'user.message', content: [{ type: 'text', text: 'Next' }] }], { observedAt: 4 }).state;
    const late = apply([{ id: 'late_fact', type: 'agent.message', content: [{ type: 'text', text: 'Late delivery from old execution' }] }], second, { executionId: 'input' });
    expect(late.state.items.late_fact.turn_id).toBe(first.turnOrder[0]);
    expect(late.state.turns[second.turnOrder[1]].status).toBe('queued');
  });

  it('rejects cross-session facts instead of contaminating an existing projection', () => {
    expect(() => apply([{ id: 'foreign', type: 'agent.message', session_id: 'other', content: [{ type: 'text', text: 'private' }] }])).toThrow(/session/i);
  });
  it('does not let a shared runtime execution ID mix parent and child turns', () => {
    const result = apply([
      { id: 'root_run', type: 'session.status_running' },
      { id: 'child_open', type: 'session.thread_created', sessionThreadId: 'child' },
      { id: 'child_input', type: 'agent.thread_message_received', sessionThreadId: 'child', fromSessionThreadId: 'root', content: [{ type: 'text', text: 'Task' }] },
      { id: 'child_output', type: 'agent.message', sessionThreadId: 'child', content: [{ type: 'text', text: 'Child output' }] },
      { id: 'root_output', type: 'agent.message', content: [{ type: 'text', text: 'Root output' }] },
    ], fresh(), { executionId: 'input' });
    expect(result.state.turnOrder).toHaveLength(2);
    expect(result.state.items.child_output.turn_id).not.toBe(result.state.items.root_output.turn_id);
    expect(result.state.turns[result.state.items.child_output.turn_id!].subagent_id).toBe('child');
  });

  it('normalizes the native primary thread in child parents and inter-agent peers', () => {
    const result = apply([
      { id: 'root_run', type: 'session.status_running', sessionThreadId: 'sthr_primary' },
      { id: 'child_open', type: 'session.thread_created', sessionThreadId: 'child', parentThreadId: 'sthr_primary' },
      { id: 'send', type: 'agent.thread_message_sent', sessionThreadId: 'sthr_primary', toSessionThreadId: 'child', content: [{ type: 'text', text: 'Task' }] },
      { id: 'receive', type: 'agent.thread_message_received', sessionThreadId: 'child', fromSessionThreadId: 'sthr_primary', content: [{ type: 'text', text: 'Task' }] },
      { id: 'child_run', type: 'session.thread_status_running', sessionThreadId: 'child' },
      { id: 'child_span', type: 'span.model_request_end', sessionThreadId: 'child' },
      { id: 'child_idle', type: 'session.thread_status_idle', sessionThreadId: 'child', stopReason: { type: 'end_turn' } },
      { id: 'root_answer', type: 'agent.message', sessionThreadId: 'sthr_primary', content: [{ type: 'text', text: 'Parent continues' }] },
    ], fresh(), { executionId: 'input' });
    expect(result.state.subagents.child.parent_agent_id).toBe('a');
    expect(result.state.items.send).toMatchObject({ sender_agent_id: 'a', recipient_agent_id: 'child', turn_id: result.state.turnOrder[0] });
    expect(result.state.items.receive).toMatchObject({ sender_agent_id: 'a', recipient_agent_id: 'child', turn_id: result.state.turnOrder[1] });
    expect(result.state.turnOrder).toHaveLength(2);
    expect(result.state.turns[result.state.turnOrder[0]]).toMatchObject({ subagent_id: null, status: 'in_progress' });
    expect(result.state.turns[result.state.turnOrder[1]]).toMatchObject({ subagent_id: 'child', status: 'completed' });
    expect(result.state.items.root_answer.turn_id).toBe(result.state.turnOrder[0]);
    expect(result.state.unresolved).toEqual([]);
  });

  it('does not infer successful text completion from a persisted partial message', () => {
    const partial = apply([
      { id: 'run', type: 'session.status_running' },
      { id: 'message', type: 'agent.message', content: [{ type: 'text', text: 'Partial answer' }] },
    ]);
    expect(partial.state.items.message).toMatchObject({ status: 'in_progress' });
    expect(partial.events.filter(e => e.type === 'agent.session.turn.item.done')).toEqual([]);
    const interrupted = apply([{ id: 'cancel', type: 'user.interrupt' }], partial.state);
    expect(interrupted.state.items.message).toMatchObject({ status: 'incomplete' });
    expect(interrupted.events.filter(e => e.type === 'agent.session.turn.item.done')).toHaveLength(1);
    const closed = apply([{ type: 'agent.message_stream_end', message_id: 'message', status: 'aborted' }], interrupted.state);
    expect(closed.events.filter(e => e.type === 'agent.session.turn.item.done')).toEqual([]);
  });

  it('merges raw committed message IDs with live items and keeps explicitly completed items complete', () => {
    const live = apply([
      { type: 'agent.message_stream_start', message_id: 'raw_message' },
      { type: 'agent.message_chunk', message_id: 'raw_message', delta: 'Actual text' },
      { type: 'agent.message_stream_end', message_id: 'raw_message', status: 'completed' },
    ], fresh(), { batchId: 'raw_live' });
    expect(live.state.items.raw_message).toMatchObject({ status: 'completed' });
    const committed = apply([{ type: 'agent.message', message_id: 'raw_message', content: [{ type: 'text', text: 'Actual text' }] }], live.state, { batchId: 'committed' });
    expect(committed.state.itemOrder).toEqual(['input', 'raw_message']);
    expect(committed.state.items.raw_message).toMatchObject({ content: [{ type: 'output_text', text: 'Actual text' }], status: 'completed' });
    expect(committed.events.filter(e => e.type === 'agent.session.turn.item.done')).toHaveLength(0);
  });

});
