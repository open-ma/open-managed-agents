import type { AgentSession, AgentSessionEvent, AgentSessionItem, Subagent, TokenUsage, SessionTurnError } from 'openai/resources/beta/agents/agents';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns';
import { OPENMA_EVENT_SCHEMA_VERSION, reduceWorkItemEvent, type OpenMAEvent, type WorkItemSnapshot } from '@openma/common/session-events/openma';
import { applyToolResult, toolItem } from './projection-items';

export interface ManagedProjectionEvent { type: string; id?: string; [key: string]: unknown }
export interface ProjectionContext {
  /** Observation time in Unix seconds; never used for event sorting. */
  observedAt: number;
  laneId?: string | null;
  rootLaneId?: string;
  executionId?: string;
  /** Stable identity of an ordered delivery, required for ID-less delta events. */
  batchId?: string;
  session?: AgentSession;
}
interface LaneState { currentTurnId: string | null; ambiguous: boolean }
interface CallState { turnId: string; laneId: string; itemId: string; kind: 'custom' | 'function' | 'command' | 'mcp' | 'webSearch' | 'coordination'; pending: boolean; name: string; arguments: unknown }
export interface ProjectionState {
  version: 1;
  sessionId: string;
  agentId: string;
  createdAt: number;
  status: AgentSession['status'];
  error: string | null;
  requiredActions: AgentSession['required_actions'];
  usage: TokenUsage | null;
  turns: Record<string, Turn>;
  turnOrder: string[];
  items: Record<string, AgentSessionItem>;
  itemOrder: string[];
  itemLanes: Record<string, string>;
  outputIndices: Record<string, number>;
  completedItems: Record<string, true>;
  subagents: Record<string, Subagent>;
  subagentOrder: string[];
  lanes: Record<string, LaneState>;
  calls: Record<string, CallState>;
  inputTurns: Record<string, string>;
  executionTurns: Record<string, string>;
  seenEventIds: Record<string, true>;
  /** Replay-only indexes over common events; native event history remains authoritative. */
  workItems: Record<string, WorkItemSnapshot>;
  workItemLanes: Record<string, string>;
  parentToolLanes: Record<string, string>;
  /** Ordered source events which lack facts needed for a public representation. */
  unresolved: Array<{ eventId: string; type: string; reason: string }>;
}
export interface ProjectionResult { state: ProjectionState; events: AgentSessionEvent[] }
export class ProjectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProjectionError'; }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const field = (value: Record<string, unknown>, camel: string, snake: string = camel): unknown => value[camel] ?? value[snake];
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const own = <T>(value: Record<string, T>, key: string): T | undefined => Object.hasOwn(value, key) ? value[key] : undefined;
function put<T>(value: Record<string, T>, key: string, item: T): void { Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true }); }
const isTerminal = (turn: Turn): boolean => ['completed', 'failed', 'cancelled'].includes(turn.status);
const terminalStatus = (turn: Turn): 'completed' | 'incomplete' => turn.status === 'cancelled' || turn.status === 'failed' ? 'incomplete' : 'completed';
function eventTime(event: ManagedProjectionEvent, context: ProjectionContext): number {
  const raw = field(event, 'processedAt', 'processed_at');
  if (typeof raw === 'string') { const time = Date.parse(raw); if (Number.isFinite(time)) return Math.floor(time / 1000); }
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw > 1e11 ? raw / 1000 : raw);
  return context.observedAt;
}
function normalizeLane(lane: string | null | undefined, context: ProjectionContext): string {
  return lane == null || lane === 'main' || lane === 'root' || lane === 'sthr_primary' || lane === context.rootLaneId ? 'root' : lane;
}
function laneKey(event: ManagedProjectionEvent, context: ProjectionContext): string {
  return normalizeLane(str(field(event, 'sessionThreadId', 'session_thread_id')) ?? context.laneId, context);
}
const eventId = (source: string, suffix: string): string => `evt_${encodeURIComponent(source)}:${suffix}`;
const turnId = (state: ProjectionState, lane: string, source: string): string => `turn_${encodeURIComponent(state.sessionId)}:${encodeURIComponent(lane)}:${encodeURIComponent(source)}`;
const clone = <T>(value: T): T => structuredClone(value);

export function createProjectionState(input: { sessionId: string; agentId: string; createdAt: number }): ProjectionState {
  return { version: 1, ...input, status: 'idle', error: null, requiredActions: [], usage: null, turns: {}, turnOrder: [], items: {}, itemOrder: [], itemLanes: {}, outputIndices: {}, completedItems: {}, subagents: {}, subagentOrder: [], lanes: { root: { currentTurnId: null, ambiguous: false } }, calls: {}, inputTurns: {}, executionTurns: {}, seenEventIds: {}, workItems: {}, workItemLanes: {}, parentToolLanes: {}, unresolved: [] };
}
export function validateToolResult(state: ProjectionState, input: { turnId: string; callId: string }): void {
  const call = own(state.calls, input.callId);
  const turn = call && own(state.turns, call.turnId);
  if (!call || call.kind !== 'custom' || !call.pending || call.turnId !== input.turnId || !turn || isTerminal(turn)) throw new ProjectionError('invalid_tool_result', 'The function call is not pending in this session and turn');
}

type InputPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };
function inputContent(value: unknown): InputPart[] {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? [{ type: 'text', text: value }] : [];
  return parts.flatMap<InputPart>(part => {
    const item = record(part);
    if ((item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string') return [{ type: 'input_text' as const, text: item.text }];
    if (item.type === 'input_image' && typeof item.image_url === 'string') return [{ type: 'input_image' as const, image_url: item.image_url }];
    if (item.type === 'image') {
      const source = record(item.source);
      if (source.type === 'url' && typeof source.url === 'string') return [{ type: 'input_image' as const, image_url: source.url }];
      if (source.type === 'base64' && typeof source.data === 'string') return [{ type: 'input_image' as const, image_url: `data:${field(source, 'mediaType', 'media_type')};base64,${source.data}` }];
    }
    return [];
  });
}
function texts(value: unknown): Array<{ type: 'output_text'; text: string }> {
  return inputContent(value).flatMap(part => part.type === 'input_text' ? [{ type: 'output_text', text: part.text }] : []);
}
function updateSessionStatus(state: ProjectionState): void {
  const roots = state.lanes.root;
  const root = roots?.currentTurnId ? own(state.turns, roots.currentTurnId) : undefined;
  const active = state.turnOrder.map(id => state.turns[id]).filter(turn => !isTerminal(turn));
  const liveTurnIds = new Set(active.map(turn => turn.id));
  state.requiredActions = state.requiredActions.filter(action => action.type !== 'function_call' || liveTurnIds.has(action.turn_id));
  state.status = state.requiredActions.length > 0 ? 'requires_action' : active.length > 0 ? 'in_progress' : 'idle';
  state.error = root?.status === 'failed' ? root.error?.message ?? null : null;
}

export function acceptInput(state: ProjectionState, events: readonly ManagedProjectionEvent[], context: ProjectionContext): ProjectionResult {
  return applyManagedEvents(state, events, context);
}

export function applyManagedEvents(previous: ProjectionState, managedEvents: readonly (ManagedProjectionEvent | OpenMAEvent)[], context: ProjectionContext): ProjectionResult {
  if (!Number.isFinite(context.observedAt) || context.observedAt < 0) throw new ProjectionError('invalid_observation_time', 'observedAt must be Unix seconds');
  if (context.session && context.session.id !== previous.sessionId) throw new ProjectionError('session_mismatch', 'Session snapshot belongs to another projection');
  const state = clone(previous);
  state.workItems ??= {}; state.workItemLanes ??= {}; state.parentToolLanes ??= {};
  const emitted: AgentSessionEvent[] = [];
  const emit = (value: unknown): void => { emitted.push(clone(value) as AgentSessionEvent); };
  function emitTurn(turn: Turn, source: string, kind: string): void {
    emit({ type: `agent.session.turn.${kind}`, event_id: eventId(source, `turn.${kind}`), session_id: state.sessionId, turn_id: turn.id, turn, ...(isTerminal(turn) ? { usage: turn.usage } : {}) });
  }
  function lane(name: string): LaneState {
    const existing = own(state.lanes, name);
    if (existing) return existing;
    const next = { currentTurnId: null, ambiguous: false };
    put(state.lanes, name, next); return next;
  }
  function locateTurn(name: string): Turn | undefined {
    const execution = context.executionId;
    const executionKey = execution && `${encodeURIComponent(name)}:${encodeURIComponent(execution)}`;
    const assigned = execution && (own(state.executionTurns, executionKey!) ?? own(state.inputTurns, execution));
    const assignedTurn = assigned ? own(state.turns, assigned) : undefined;
    if (assignedTurn && (assignedTurn.subagent_id ?? 'root') === name) return assignedTurn;
    const current = lane(name).currentTurnId;
    const turn = current ? own(state.turns, current) : undefined;
    if (turn && executionKey) put(state.executionTurns, executionKey, turn.id);
    return turn;
  }
  function startTurn(name: string, source: string, at: number): Turn {
    const current = locateTurn(name);
    if (current && !isTerminal(current)) return current;
    const id = turnId(state, name, source);
    const next: Turn = { id, agent_id: name === 'root' ? state.agentId : name, object: 'agent.session.turn', session_id: state.sessionId, subagent_id: name === 'root' ? null : name, created_at: at, started_at: null, completed_at: null, status: 'queued', error: null, usage: null };
    put(state.turns, id, next); state.turnOrder.push(id); lane(name).currentTurnId = id; lane(name).ambiguous = false;
    if (context.executionId) put(state.executionTurns, `${encodeURIComponent(name)}:${encodeURIComponent(context.executionId)}`, id);
    emitTurn(next, source, 'created'); return next;
  }
  function itemIndex(item: AgentSessionItem, name: string): number | null {
    if (item.type === 'message' && item.role === 'user') return null;
    if (item.type === 'function_call_output' || item.type === 'agent_message') return null;
    if (item.id === null) return null;
    const existing = own(state.outputIndices, item.id);
    if (existing !== undefined) return existing;
    const index = state.itemOrder.filter(id => own(state.itemLanes, id) === name && state.items[id].turn_id === item.turn_id && own(state.outputIndices, id) !== undefined).length;
    put(state.outputIndices, item.id, index); return index;
  }
  function saveItem(item: AgentSessionItem, name: string, source: string, final: boolean): void {
    if (item.id === null) throw new ProjectionError('missing_item_id', 'New items need stable managed event IDs');
    const existing = own(state.items, item.id);
    if (existing && (existing.turn_id !== item.turn_id || own(state.itemLanes, item.id) !== name)) throw new ProjectionError('item_scope_conflict', 'A managed item ID was reused in another lane or turn');
    const outputIndex = itemIndex(item, name);
    if (!existing) {
      state.itemOrder.push(item.id); put(state.itemLanes, item.id, name);
      emit({ type: 'agent.session.turn.item.added', event_id: eventId(source, `item.${encodeURIComponent(item.id)}.added`), session_id: state.sessionId, turn_id: item.turn_id, output_index: outputIndex, item });
    }
    put(state.items, item.id, clone(item));
    if (final && outputIndex !== null && !own(state.completedItems, item.id)) {
      put(state.completedItems, item.id, true);
      if (item.type === 'message') item.content.forEach((part, content_index) => {
        if (part.type !== 'output_text') return;
        emit({ type: 'agent.session.turn.output_text.done', event_id: eventId(source, `item.${encodeURIComponent(item.id!)}.text.${content_index}.done`), session_id: state.sessionId, turn_id: item.turn_id, item_id: item.id, output_index: outputIndex, content_index, text: part.text });
        emit({ type: 'agent.session.turn.content_part.done', event_id: eventId(source, `item.${encodeURIComponent(item.id!)}.part.${content_index}.done`), session_id: state.sessionId, turn_id: item.turn_id, item_id: item.id, output_index: outputIndex, content_index, part });
      });
      if (item.type === 'reasoning') item.summary.forEach((part, summary_index) => {
        emit({ type: 'agent.session.turn.reasoning_summary_text.done', event_id: eventId(source, `item.${encodeURIComponent(item.id!)}.summary.${summary_index}.text.done`), session_id: state.sessionId, turn_id: item.turn_id, item_id: item.id, output_index: outputIndex, summary_index, text: part.text });
        emit({ type: 'agent.session.turn.reasoning_summary_part.done', event_id: eventId(source, `item.${encodeURIComponent(item.id!)}.summary.${summary_index}.part.done`), session_id: state.sessionId, turn_id: item.turn_id, item_id: item.id, output_index: outputIndex, summary_index, part, status: item.status === 'incomplete' ? 'incomplete' : null });
      });
      emit({ type: 'agent.session.turn.item.done', event_id: eventId(source, `item.${encodeURIComponent(item.id)}.done`), session_id: state.sessionId, turn_id: item.turn_id, output_index: outputIndex, item });
    }
  }
  function finish(turn: Turn, status: 'completed' | 'failed' | 'cancelled', at: number, source: string, error: SessionTurnError | null = null): void {
    if (isTerminal(turn)) return;
    turn.status = status; turn.completed_at = at; turn.error = error;
    for (const [id, call] of Object.entries(state.calls)) {
      if (call.turnId !== turn.id || !call.pending) continue;
      call.pending = false;
      const item = own(state.items, call.itemId);
      if (item && 'status' in item) { item.status = status === 'completed' ? 'completed' : 'incomplete'; saveItem(item, call.laneId, `${source}:${id}`, true); }
    }
    for (const id of state.itemOrder) {
      const item = state.items[id];
      if (item.turn_id !== turn.id || !('status' in item) || item.status !== 'in_progress') continue;
      const updated = { ...item, status: status === 'completed' ? 'completed' : 'incomplete' } as AgentSessionItem;
      saveItem(updated, state.itemLanes[id], source, true);
    }
    state.requiredActions = state.requiredActions.filter(action => action.type !== 'function_call' || action.turn_id !== turn.id);
    emitTurn(turn, source, status);
  }
  function unresolved(event: ManagedProjectionEvent, id: string, reason: string): void { state.unresolved.push({ eventId: id, type: event.type, reason }); }
  function openChild(name: string, parent: string, source: string, at: number, title: string | null, instructions: unknown): Subagent {
    const existing = own(state.subagents, name);
    if (existing) return existing;
    const parentLane = normalizeLane(parent, context);
    const child: Subagent = { id: name, object: 'agent.session.subagent', session_id: state.sessionId, parent_agent_id: parentLane === 'root' ? state.agentId : own(state.workItemLanes, parentLane) ?? parentLane, opened_at: at, closed_at: null, status: 'active', name: title, instructions: instructions === undefined ? null : texts(instructions) };
    put(state.subagents, name, child); state.subagentOrder.push(name); lane(name);
    emit({ type: 'agent.session.subagent.created', event_id: eventId(source, 'subagent.created'), subagent: child });
    return child;
  }
  function closeChild(name: string, source: string, at: number): void {
    const child = own(state.subagents, name);
    if (!child || child.status === 'closed') return;
    child.status = 'closed'; child.closed_at = at;
    const turn = locateTurn(name);
    if (turn && !isTerminal(turn)) finish(turn, 'cancelled', at, source);
    emit({ type: 'agent.session.subagent.closed', event_id: eventId(source, 'subagent.closed'), subagent: child });
  }

  for (const [index, sourceEvent] of managedEvents.entries()) {
    const raw = sourceEvent as ManagedProjectionEvent;
    const canonical = raw.schema_version === OPENMA_EVENT_SCHEMA_VERSION ? sourceEvent as OpenMAEvent : null;
    const data = canonical ? record(canonical.data) : {};
    const event: ManagedProjectionEvent = canonical ? { ...raw, ...data, id: canonical.event_id, processedAt: canonical.occurred_at, content: data.content ?? data.text, messageId: data.message_id } : raw;
    if (canonical?.type === 'agent.message_chunk') event.delta = data.text;
    if (canonical?.type === 'tool.started') {
      event.type = data.kind === 'custom' ? 'agent.custom_tool_use' : data.kind === 'mcp' ? 'agent.mcp_tool_use' : 'agent.tool_use';
      event.name = data.tool_name ?? data.title;
      event.input = data.raw_input;
      event.mcp_server_name = data.server_label ?? record(data.adapter_meta).mcp_server_name;
    } else if (canonical?.type === 'tool.completed' || canonical?.type === 'tool.failed' || canonical?.type === 'tool.cancelled') {
      event.type = 'agent.tool_result';
      event.toolUseId = data.tool_call_id;
      event.isError = canonical.type !== 'tool.completed';
      event.content = data.content ?? data.raw_output ?? record(data.output).data;
    }
    const eventSession = str(field(event, 'sessionId', 'session_id'));
    if (eventSession !== null && eventSession !== state.sessionId) throw new ProjectionError('session_mismatch', 'Managed event belongs to another session');
    const explicitLane = laneKey(event, context);
    const parentTool = str(event.parent_id ?? event.parent_tool_use_id ?? event.parentToolUseId);
    const parentLane = parentTool ? own(state.parentToolLanes, parentTool) : undefined;
    const name = own(state.workItemLanes, explicitLane) ?? (explicitLane === 'root' ? parentLane : undefined) ?? explicitLane;
    const streamIdentity = str(field(event, 'messageId', 'message_id')) ?? str(field(event, 'thinkingId', 'thinking_id'));
    const committedIdentity = event.type === 'agent.message' || event.type === 'agent.thinking' ? streamIdentity : null;
    const startIdentity = event.type === 'event_start' ? str(record(event.event).id) : null;
    const id = event.id ?? committedIdentity ?? startIdentity ?? (context.batchId ? `${context.batchId}:${index}` : event.type.endsWith('_start') || event.type.endsWith('_end') ? streamIdentity ?? undefined : undefined);
    if (!id) throw new ProjectionError('missing_event_identity', `Event ${event.type} needs a stable ID or batchId`);
    const seenKey = `${encodeURIComponent(name)}:${encodeURIComponent(event.type)}:${encodeURIComponent(id)}`;
    if (own(state.seenEventIds, seenKey)) continue;
    put(state.seenEventIds, seenKey, true);
    const at = eventTime(event, context);
    const beforeStatus = state.status;
    const beforeActions = JSON.stringify(state.requiredActions);
    if (canonical && event.type.startsWith('work_item.')) {
      const workId = canonical.work_item_id;
      if (!workId) { unresolved(event, id, 'Work item is missing its identity'); continue; }
      const previousWork = own(state.workItems, workId);
      const registry = reduceWorkItemEvent({ items: new Map(Object.entries(state.workItems)), seen_event_ids: new Set() }, canonical);
      state.workItems = Object.fromEntries(registry.items);
      const work = own(state.workItems, workId);
      if (event.type === 'work_item.reidentified') {
        const previousId = str(data.previous_work_item_id);
        const assigned = previousId ? own(state.workItemLanes, previousId) : undefined;
        if (assigned) put(state.workItemLanes, workId, assigned);
      } else if (work?.kind === 'agent') {
        const childLane = own(state.workItemLanes, workId) ?? workId;
        put(state.workItemLanes, workId, childLane);
        if (parentTool) put(state.parentToolLanes, parentTool, childLane);
        if ((event.type === 'work_item.started' || event.type === 'work_item.classified') && work.status === 'running') {
          const parent = parentTool ? own(state.calls, parentTool)?.laneId ?? name : name;
          openChild(childLane, parent, id, work.started_at ? Math.floor(Date.parse(work.started_at) / 1000) : at, work.title ?? null, undefined);
          const turn = startTurn(childLane, id, at);
          if (turn.status !== 'in_progress') { turn.status = 'in_progress'; turn.started_at ??= at; emitTurn(turn, id, 'in_progress'); }
        } else {
          const turn = locateTurn(childLane);
          const wasTerminal = previousWork && previousWork.status !== 'running' && previousWork.status !== 'unknown';
          if (!wasTerminal && turn && !isTerminal(turn)) {
            if (event.type === 'work_item.completed') finish(turn, 'completed', at, id);
            else if (event.type === 'work_item.failed') finish(turn, 'failed', at, id, { code: 'server_error', message: work.error ?? work.reason ?? 'Subagent execution failed' });
            else if (event.type === 'work_item.cancelled') finish(turn, 'cancelled', at, id);
          }
          if (event.type === 'work_item.killed' || event.type === 'work_item.terminated') closeChild(childLane, id, at);
        }
      }
    } else if (event.type === 'user.message') {
      const turn = startTurn(name, id, at); put(state.inputTurns, id, turn.id);
      saveItem({ id, type: 'message', turn_id: turn.id, role: 'user', content: inputContent(event.content), phase: null, status: 'completed' }, name, id, false);
    } else if (event.type === 'user.custom_tool_result' || event.type === 'user.tool_result' || event.type === 'agent.tool_result' || event.type === 'agent.mcp_tool_result') {
      const callId = str(field(event, 'customToolUseId', 'custom_tool_use_id')) ?? str(field(event, 'toolUseId', 'tool_use_id')) ?? str(field(event, 'mcpToolUseId', 'mcp_tool_use_id'));
      const call = callId ? own(state.calls, callId) : undefined;
      if (!call) { unresolved(event, id, 'Tool result has no observed matching call'); continue; }
      const turn = own(state.turns, call.turnId)!;
      if (!call.pending) continue;
      const error = field(event, 'isError', 'is_error') === true;
      const item = own(state.items, call.itemId)!;
      if (item.type === 'function_call') {
        item.status = error ? 'failed' : 'completed'; saveItem(item, call.laneId, id, true);
        saveItem({ id, type: 'function_call_output', turn_id: turn.id, call_id: callId!, status: error ? 'failed' : 'completed', error: error ? texts(event.content).map(part => part.text).join('\n') : null, output: error ? null : inputContent(event.content) }, call.laneId, id, false);
      }
      if (item.type !== 'function_call') saveItem(applyToolResult(item, event), call.laneId, id, true);
      call.pending = false;
      state.requiredActions = state.requiredActions.filter(action => action.type !== 'function_call' || action.call_id !== callId);
      put(state.inputTurns, id, turn.id);
      if (call.kind === 'custom' && !isTerminal(turn) && !Object.values(state.calls).some(value => value.turnId === turn.id && value.kind === 'custom' && value.pending)) turn.status = 'queued';
    } else {
      let turn = locateTurn(name);
      if (event.type === 'session.thread_created') {
        if (name === 'root') { unresolved(event, id, 'Thread creation is missing its child identity'); continue; }
        const parent = str(field(event, 'parentThreadId', 'parent_thread_id')) ?? context.laneId ?? 'root';
        openChild(name, parent, id, at, str(field(event, 'agentName', 'agent_name')), event.content);
        if (parentTool) put(state.parentToolLanes, parentTool, name);
      } else if (event.type === 'agent.thread_message_sent' || event.type === 'agent.thread_message_received') {
        const sent = event.type === 'agent.thread_message_sent';
        const peer = str(sent ? field(event, 'toSessionThreadId', 'to_session_thread_id') : field(event, 'fromSessionThreadId', 'from_session_thread_id'));
        if (!peer) { unresolved(event, id, 'Inter-agent message is missing its peer identity'); continue; }
        if (!sent && (!turn || isTerminal(turn))) turn = startTurn(name, id, at);
        if (!turn) { unresolved(event, id, 'Inter-agent message has no observed sender turn'); continue; }
        const selfId = name === 'root' ? state.agentId : name;
        const peerLane = normalizeLane(peer, context);
        const peerId = peerLane === 'root' ? state.agentId : own(state.workItemLanes, peerLane) ?? peerLane;
        saveItem({ id, type: 'agent_message', turn_id: turn.id, sender_agent_id: sent ? selfId : peerId, recipient_agent_id: sent ? peerId : selfId, content: texts(event.content) }, name, id, false);
        if (!sent) put(state.inputTurns, id, turn.id);
        const child = own(state.subagents, sent ? peer : name);
        if (child && child.instructions === null) child.instructions = texts(event.content);
      } else if (event.type === 'session.thread_status_terminated') {
        closeChild(name, id, at);
      } else if (event.type === 'session.status_running' || event.type === 'session.thread_status_running') {
        const child = own(state.subagents, name);
        const resuming = child?.status === 'closed';
        if (resuming) { child.status = 'active'; child.closed_at = null; emit({ type: 'agent.session.subagent.active', event_id: eventId(id, 'subagent.active'), subagent: child }); }
        if ((!turn || isTerminal(turn)) && child && !resuming) turn = startTurn(name, id, at);
        if (resuming && (!turn || isTerminal(turn))) continue;
        if (!turn) { unresolved(event, id, 'Running event has no observed input or subagent opening'); continue; }
        if (!isTerminal(turn)) { turn.status = 'in_progress'; turn.started_at ??= at; lane(name).ambiguous = false; emitTurn(turn, id, 'in_progress'); }
      } else if (event.type === 'user.interrupt') {
        if (turn && !isTerminal(turn)) finish(turn, 'cancelled', at, id);
      } else if (event.type === 'session.error') {
        const error = record(event.error);
        const retry = field(error, 'retryStatus', 'retry_status');
        const retryType = typeof retry === 'string' ? retry : record(retry).type;
        if (turn && !isTerminal(turn) && (retryType === 'terminal' || retryType === 'exhausted')) finish(turn, 'failed', at, id, { code: error.type === 'billing_error' ? 'usage_limit_exceeded' : error.type === 'model_rate_limited_error' ? 'rate_limit_exceeded' : 'server_error', message: str(error.message) ?? 'Session execution failed' });
      } else if (event.type === 'session.status_rescheduled' || event.type === 'session.thread_status_rescheduled') {
        if (turn && !isTerminal(turn)) { turn.status = 'queued'; lane(name).ambiguous = true; }
      } else if (event.type === 'session.status_idle' || event.type === 'session.thread_status_idle') {
        const child = own(state.subagents, name);
        if (event.type === 'session.thread_status_idle' && child?.status === 'closed' && event.interrupted !== true) {
          child.status = 'active'; child.closed_at = null;
          emit({ type: 'agent.session.subagent.active', event_id: eventId(id, 'subagent.active'), subagent: child });
        }
        if (!turn || isTerminal(turn)) continue;
        const reason = record(field(event, 'stopReason', 'stop_reason'));
        if (event.interrupted === true) finish(turn, 'cancelled', at, id);
        else if (reason.type === 'requires_action') turn.status = 'waiting';
        else if (reason.type === 'budget_reached' || reason.type === 'retries_exhausted') finish(turn, 'failed', at, id, { code: reason.type === 'budget_reached' ? 'session_budget_exceeded' : 'server_error', message: reason.type === 'budget_reached' ? 'Session budget reached' : 'Execution retries exhausted' });
        else if (reason.type === 'end_turn' && !lane(name).ambiguous && !Object.values(state.calls).some(call => call.turnId === turn!.id && call.pending)) finish(turn, 'completed', at, id);
        else if (reason.type !== 'end_turn') lane(name).ambiguous = true;
      } else if (event.type === 'agent.message') {
        if (!turn) { unresolved(event, id, 'Message has no observed turn association'); continue; }
        const content = texts(event.content);
        const itemId = canonical ? str(data.message_id) ?? id : id;
        const previousItem = own(state.items, itemId);
        const item: AgentSessionItem = { id: itemId, type: 'message', turn_id: turn.id, role: 'assistant', content, phase: event.phase === 'commentary' ? 'commentary' : event.phase === 'final_answer' || event.phase === 'finalAnswer' ? 'final_answer' : null, status: isTerminal(turn) ? terminalStatus(turn) : previousItem?.type === 'message' ? previousItem.status : 'in_progress' };
        saveItem(item, name, id, isTerminal(turn));
      } else if (event.type === 'agent.custom_tool_use' || event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
        if (!turn) { unresolved(event, id, 'Tool call has no observed turn association'); continue; }
        const callId = canonical ? str(data.tool_call_id) ?? id : id;
        const projected = toolItem(event, callId, turn.id, name === 'root' ? state.agentId : name);
        if (!projected) { unresolved(event, id, 'Tool call lacks a name or MCP server identity'); continue; }
        saveItem(projected.item, name, id, false);
        put(state.calls, callId, { turnId: turn.id, laneId: name, itemId: callId, kind: projected.kind, pending: !isTerminal(turn), name: event.name as string, arguments: clone(event.input ?? {}) });
        if (projected.kind === 'custom' && !isTerminal(turn)) {
          state.requiredActions.push({ type: 'function_call', turn_id: turn.id, call_id: callId, name: event.name as string, arguments: clone(event.input ?? {}) });
          turn.status = 'waiting';
        }
      } else if (event.type === 'agent.thinking') {
        if (!turn) { unresolved(event, id, 'Thinking item has no observed turn association'); continue; }
        const existing = own(state.items, id);
        const summary = existing?.type === 'reasoning' ? existing.summary : texts(event.content).map(part => ({ type: 'summary_text' as const, text: part.text }));
        saveItem({ id, type: 'reasoning', turn_id: turn.id, status: isTerminal(turn) ? terminalStatus(turn) : existing?.type === 'reasoning' ? existing.status : 'in_progress', summary }, name, id, isTerminal(turn));
      } else if (event.type === 'event_start' || event.type === 'event_delta' || /^agent\.(message|thinking)(_stream_start|_chunk|_stream_end)$/.test(event.type)) {
        if (!turn) { unresolved(event, id, 'Stream update has no observed turn association'); continue; }
        const nested = record(event.event);
        const itemId = streamIdentity ?? str(field(event, 'eventId', 'event_id')) ?? str(nested.id);
        if (!itemId) { unresolved(event, id, 'Stream update has no item identity'); continue; }
        const existing = own(state.items, itemId);
        const thinking = event.type.includes('thinking') || nested.type === 'agent.thinking' || existing?.type === 'reasoning';
        const delta = typeof event.delta === 'string' ? event.delta : str(record(record(event.delta).content).text);
        const ending = event.type.endsWith('_stream_end');
        const aborted = event.status === 'aborted' || event.status === 'interrupted' || event.aborted === true;
        if (thinking) {
          const summary = existing?.type === 'reasoning' ? clone(existing.summary) : [];
          if (delta !== null) { if (summary.length === 0) summary.push({ type: 'summary_text', text: '' }); summary[0].text += delta; }
          const item: AgentSessionItem = { id: itemId, type: 'reasoning', turn_id: turn.id, status: ending ? aborted ? 'incomplete' : terminalStatus(turn) : 'in_progress', summary };
          saveItem(item, name, id, ending);
          if (delta !== null) emit({ type: 'agent.session.turn.reasoning_summary_text.delta', event_id: eventId(id, 'reasoning.delta'), session_id: state.sessionId, turn_id: turn.id, item_id: itemId, output_index: state.outputIndices[itemId], summary_index: 0, delta });
        } else {
          const content = existing?.type === 'message' ? clone(existing.content) : [];
          if (delta !== null) {
            const part = content[0];
            if (part?.type === 'output_text') part.text += delta;
            else content.push({ type: 'output_text', text: delta });
          }
          const item: AgentSessionItem = { id: itemId, type: 'message', turn_id: turn.id, role: 'assistant', content, phase: existing?.type === 'message' ? existing.phase : null, status: ending ? aborted ? 'incomplete' : terminalStatus(turn) : 'in_progress' };
          saveItem(item, name, id, ending);
          if (delta !== null) emit({ type: 'agent.session.turn.output_text.delta', event_id: eventId(id, 'text.delta'), session_id: state.sessionId, turn_id: turn.id, item_id: itemId, output_index: state.outputIndices[itemId], content_index: 0, delta });
        }
      }
    }
    updateSessionStatus(state);
    if (context.session && (state.status !== beforeStatus || JSON.stringify(state.requiredActions) !== beforeActions)) emit({ type: `agent.session.${state.status}`, event_id: eventId(id, `session.${state.status}`), session: { ...context.session, status: state.status, error: state.error, required_actions: clone(state.requiredActions), usage: state.usage } });
  }
  return { state, events: emitted };
}
