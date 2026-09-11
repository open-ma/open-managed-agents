import { describe, expect, it } from 'vitest';
import { acceptInput, applyManagedEvents, createProjectionState, validateToolResult } from '../src/projection';

const fresh = (sessionId = 'session_one') => createProjectionState({ sessionId, agentId: 'agent_one', createdAt: 1 });
const context = { observedAt: 10 };
const message = (id: string, text = id, extras = {}) => ({ id, type: 'user.message', content: [{ type: 'text', text }], ...extras });
const output = (id: string, text: string, extras = {}) => ({ id, type: 'agent.message', content: [{ type: 'text', text }], ...extras });
const running = (id: string, extras = {}) => ({ id, type: 'session.status_running', ...extras });
const idle = (id: string, extras = {}) => ({ id, type: 'session.status_idle', stopReason: { type: 'end_turn' }, ...extras });
const onlyTurn = (state: any) => state.turns[state.turnOrder[0]];

describe('Ordered managed event projection', () => {
  it('keeps steering in one durable turn, preserves observed order, and replays without duplicate output', () => {
    const original = fresh();
    const accepted = acceptInput(original, [message('z_input')], context);
    const active = applyManagedEvents(accepted.state, [running('start')], { observedAt: 11 });
    const steered = acceptInput(active.state, [message('a_steer')], { observedAt: 12 });
    const complete = applyManagedEvents(steered.state, [output('z_out', 'Actual output'), idle('a_idle')], { observedAt: 13 });
    expect(original.turnOrder).toEqual([]);
    expect(complete.state.turnOrder).toHaveLength(1);
    expect(complete.state.itemOrder).toEqual(['z_input', 'a_steer', 'z_out']);
    expect(onlyTurn(complete.state)).toMatchObject({ status: 'completed', created_at: 10, started_at: 11, completed_at: 13, subagent_id: null });
    expect(complete.state.items.z_out).toMatchObject({ content: [{ type: 'output_text', text: 'Actual output' }] });
    expect(complete.events.filter((e: any) => e.type === 'agent.session.turn.completed')).toHaveLength(1);
    const replayed = applyManagedEvents(JSON.parse(JSON.stringify(complete.state)), [message('z_input'), running('start'), message('a_steer'), output('z_out', 'Actual output'), idle('a_idle')], { observedAt: 99 });
    expect(replayed.state).toEqual(complete.state);
    expect(replayed.events).toEqual([]);
    const next = acceptInput(replayed.state, [message('next_input')], { observedAt: 20 });
    expect(next.state.turnOrder).toHaveLength(2);
  });

  it('resumes custom function results in the original waiting turn and validates call ownership', () => {
    const state = acceptInput(fresh(), [message('input')], context).state;
    const waiting = applyManagedEvents(state, [running('start'), { id: 'call_one', type: 'agent.custom_tool_use', name: 'lookup', input: { customer_id: 'x' } }, { id: 'wait', type: 'session.status_idle', stopReason: { type: 'requires_action', eventIds: ['call_one'] } }], { observedAt: 11 });
    const turn = onlyTurn(waiting.state);
    expect(turn.status).toBe('waiting');
    expect(waiting.state.status).toBe('requires_action');
    expect(waiting.state.requiredActions).toEqual([{ type: 'function_call', turn_id: turn.id, call_id: 'call_one', name: 'lookup', arguments: { customer_id: 'x' } }]);
    expect(() => validateToolResult(waiting.state, { turnId: 'wrong', callId: 'call_one' })).toThrow();
    expect(() => validateToolResult(fresh('other'), { turnId: turn.id, callId: 'call_one' })).toThrow();
    validateToolResult(waiting.state, { turnId: turn.id, callId: 'call_one' });
    const resumed = acceptInput(JSON.parse(JSON.stringify(waiting.state)), [{ id: 'result_one', type: 'user.custom_tool_result', customToolUseId: 'call_one', content: [{ type: 'text', text: '{"found":true}' }] }], { observedAt: 12 });
    expect(resumed.state.turnOrder).toHaveLength(1);
    expect(resumed.state.requiredActions).toEqual([]);
    expect(resumed.state.items.result_one).toMatchObject({ type: 'function_call_output', call_id: 'call_one', turn_id: turn.id, output: [{ type: 'input_text', text: '{"found":true}' }] });
    const complete = applyManagedEvents(resumed.state, [running('resumed'), output('answer', 'Found'), idle('done')], { observedAt: 13 });
    expect(onlyTurn(complete.state).status).toBe('completed');
    expect(complete.state.turnOrder).toEqual(waiting.state.turnOrder);
    expect(() => validateToolResult(complete.state, { turnId: turn.id, callId: 'call_one' })).toThrow();
  });

  it.each(['cancelled', 'failed'])('does not let finally idle overwrite a %s turn', (terminal) => {
    const state = applyManagedEvents(acceptInput(fresh(), [message('input')], context).state, [running('start')], { observedAt: 11 }).state;
    const trigger = terminal === 'cancelled' ? { id: 'cancel', type: 'user.interrupt' } : { id: 'fatal', type: 'session.error', error: { type: 'unknown_error', message: 'Actual failure', retryStatus: 'terminal' } };
    const ended = applyManagedEvents(state, [trigger, output('partial', 'Partial'), idle('finally')], { observedAt: 12 });
    expect(onlyTurn(ended.state).status).toBe(terminal);
    expect(ended.events.filter((e: any) => e.type === 'agent.session.turn.completed')).toEqual([]);
    expect(ended.events.filter((e: any) => e.type === `agent.session.turn.${terminal}`)).toHaveLength(1);
    expect(ended.state.items.partial).toMatchObject({ status: 'incomplete' });
    const noop = acceptInput(ended.state, [{ id: 'noop_cancel', type: 'user.interrupt' }], { observedAt: 20 });
    expect(onlyTurn(noop.state).status).toBe(terminal);
    expect(noop.events).toEqual([]);
  });

  it('keeps retrying and ambiguous idle nonterminal until explicit completion evidence', () => {
    const start = acceptInput(fresh(), [message('input')], context).state;
    const retrying = applyManagedEvents(start, [running('start'), { id: 'retry', type: 'session.error', error: { type: 'model_rate_limited_error', message: 'Retry', retryStatus: 'retrying' } }, { id: 'reschedule', type: 'session.status_rescheduled' }, { id: 'cleanup', type: 'session.status_idle' }], { observedAt: 11 });
    expect(['queued', 'in_progress']).toContain(onlyTurn(retrying.state).status);
    expect(onlyTurn(retrying.state).completed_at).toBeNull();
    expect(retrying.events.some((e: any) => e.type === 'agent.session.turn.completed')).toBe(false);
    const done = applyManagedEvents(retrying.state, [running('restart'), idle('end')], { observedAt: 12 });
    expect(onlyTurn(done.state).status).toBe('completed');
  });
});
