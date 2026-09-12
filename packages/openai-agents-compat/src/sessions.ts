import type { AgentSession } from "openai/resources/beta/agents/agents";
import type { SessionsApplicationPort, SessionView, CreateSessionCommand } from "@open-managed-agents/managed-agents-application/ports/sessions";
import type { SessionEventsApplicationPort, SendableSessionEvent } from "@open-managed-agents/managed-agents-application/ports/session-events";
import { sessionInputIdentityPrefix, type SessionRuntimeHistoryApplicationPort } from "@open-managed-agents/managed-agents-application";
import { OpenAIAgentsProtocolError, type OpenAIAgentsOperationRequest, type OpenAIAgentsOperationResponse, type OpenAIAgentsProtocolPort } from "@open-managed-agents/openai-agents-api";
import { applyManagedEvents, createProjectionState, validateToolResult, type ProjectionState, type ManagedProjectionEvent } from "./projection";
import { toManagedInputContent as inputContent } from "./session-mapping";

export interface SessionSemanticMapping {
  prepareCreate(body: Record<string, unknown>): Promise<CreateSessionCommand>;
  sessionView(session: SessionView): Promise<AgentSession>;
  prepareMetadata(session: SessionView, metadata: Record<string, string> | null): Promise<Record<string, string | null>>;
}
export interface SessionSemanticDependencies {
  workspaceId: string;
  sessions: SessionsApplicationPort;
  sessionEvents: SessionEventsApplicationPort;
  history: SessionRuntimeHistoryApplicationPort;
  mapping: SessionSemanticMapping;
  /** Existing Files/output implementations own artifact bytes and publication. */
  resources?: OpenAIAgentsProtocolPort;
  pollMs?: number;
}
const missing = (): never => { throw new OpenAIAgentsProtocolError(404, "Resource not found"); };
const invalid = (message: string, param?: string): never => { throw new OpenAIAgentsProtocolError(400, message, param); };
const page = <T extends {id: string | null}>(values: T[], query: OpenAIAgentsOperationRequest["query"], sort = false) => {
  const ordered = [...values];
  if (sort) ordered.sort((a: any, b: any) => (a.created_at ?? a.opened_at) - (b.created_at ?? b.opened_at) || String(a.id).localeCompare(String(b.id)));
  if (query.order !== "asc") ordered.reverse();
  const after = query.after == null ? -1 : ordered.findIndex(item => item.id === query.after);
  if (query.after != null && after < 0) invalid("Cursor does not belong to this collection", "after");
  const offset = after + 1, limit = Number(query.limit ?? 20);
  return { data: ordered.slice(offset, offset + limit), has_more: offset + limit < ordered.length };
};
const observedAt = (event: ManagedProjectionEvent, fallback: number): number => typeof event.processedAt === "string" && Number.isFinite(Date.parse(event.processedAt)) ? Math.floor(Date.parse(event.processedAt) / 1000) : fallback;
function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort",done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort",done,{once:true});
  });
}
export function createSessionsHandler(deps: SessionSemanticDependencies): OpenAIAgentsProtocolPort {
  async function nativeSession(sessionId: string): Promise<SessionView> {
    const found = await deps.sessions.retrieveSession({sessionId});
    return found.type === "found" ? found.session : missing();
  }
  async function history(sessionId: string) {
    const found = await deps.history.loadSessionRuntimeHistory({sessionId});
    if (found.type !== "found") return missing();
    if (!found.orderedEvents && found.events.length) throw new OpenAIAgentsProtocolError(409,"This legacy session has no reliable event ordering for a Turn projection",undefined,"history_order_unavailable");
    return found;
  }
  function projectedSession(base: AgentSession, state: ProjectionState): AgentSession {
    return {...base,status:state.status,error:state.error,required_actions:state.requiredActions,usage:state.usage};
  }
  async function snapshot(sessionId: string) {
    const native = await nativeSession(sessionId);
    const base = await deps.mapping.sessionView(native);
    const found = await history(sessionId);
    let state = createProjectionState({sessionId,agentId:base.agent.id,createdAt:base.created_at});
    const initial = found.initialEvents.map((event,index) => ({...event,id:`bootstrap_${sessionId}:${index}`,processedAt:native.createdAt}));
    state = applyManagedEvents(state,initial,{observedAt:base.created_at,session:base}).state;
    for (const entry of found.orderedEvents ?? []) state = applyManagedEvents(state,[entry.event as ManagedProjectionEvent],{observedAt:observedAt(entry.event as ManagedProjectionEvent,base.last_active_at),executionId:entry.executionId,session:base}).state;
    return {native,base,state,initial,found,session:projectedSession(base,state)};
  }
  async function* stream(sessionId: string, signal: AbortSignal, includeCreation: boolean, baseline: Awaited<ReturnType<typeof snapshot>>) {
    let state = includeCreation ? createProjectionState({sessionId,agentId:baseline.base.agent.id,createdAt:baseline.base.created_at}) : baseline.state;
    if (includeCreation) {
      yield {type:"agent.session.created",event_id:`evt_created_${sessionId}`,session:baseline.base};
      const initial = applyManagedEvents(state,baseline.initial,{observedAt:baseline.base.created_at,session:baseline.base});
      state = initial.state;
      for (const event of initial.events) yield event as unknown as Record<string,unknown>;
    }
    while (!signal.aborted) {
      const found = await history(sessionId);
      const native = await nativeSession(sessionId);
      const base = await deps.mapping.sessionView(native);
      for (const entry of found.orderedEvents ?? []) {
        const result = applyManagedEvents(state,[entry.event as ManagedProjectionEvent],{observedAt:observedAt(entry.event as ManagedProjectionEvent,base.last_active_at),executionId:entry.executionId,session:base});
        state = result.state;
        for (const event of result.events) { if (signal.aborted) return; yield event as unknown as Record<string,unknown>; }
      }
      await waitForPoll(deps.pollMs ?? 100,signal);
    }
  }
  async function send(request: OpenAIAgentsOperationRequest, current: Awaited<ReturnType<typeof snapshot>>) {
    const sessionId = request.params.session_id!;
    const key = request.headers.get("Idempotency-Key") ?? undefined;
    const submitted = request.body.events as Array<Record<string,any>>;
    if (!Array.isArray(submitted) || !submitted.length) return invalid("Input must contain at least one event", "events");
    const events: SendableSessionEvent[] = [];
    const validatedCalls = new Set<string>();
    const prefix = key ? await sessionInputIdentityPrefix(deps.workspaceId,sessionId,key) : null;
    const previouslyAccepted = prefix && current.found.events.some(event => event.id.startsWith(prefix));
    let validatedState = current.state;
    const validationId = crypto.randomUUID();
    for (const body of submitted) {
    const previousLength = events.length;
    if (body.type === "agent.session.input.message") {
      if (!body.input?.length) invalid("Input must contain at least one message", "input");
      events.push(...body.input.map((message: Record<string,unknown>) => ({type:"user.message" as const,content:inputContent(message.content)})));
    } else if (body.type === "agent.session.input.cancel") events.push({type:"user.interrupt"});
    else if (body.type === "agent.session.input.tool_result") {
      if (validatedCalls.has(body.call_id)) invalid("A function result appears more than once in this batch", "call_id");
      validatedCalls.add(body.call_id);
      if (previouslyAccepted && current.state.calls[body.call_id]?.turnId !== body.turn_id) invalid("Function result does not belong to this turn", "turn_id");
      if (!previouslyAccepted) {
        try { validateToolResult(validatedState,{turnId:body.turn_id,callId:body.call_id}); }
        catch { invalid("Function call is not pending in this session and turn", "call_id"); }
      }
      events.push({type:"user.custom_tool_result",customToolUseId:body.call_id,isError:!body.success,content:inputContent(body.success ? body.output : body.error ?? "Function failed")});
    } else return invalid("Unknown session input", "type");
    if (!previouslyAccepted) {
      // Simulate only to validate this atomic batch. Canonical state is always
      // rebuilt from accepted native events, never from these temporary IDs.
      validatedState = applyManagedEvents(validatedState, events.slice(previousLength).map((event,index) => ({...event,id:`validation_${validationId}_${events.length}_${index}`})), {observedAt:current.base.last_active_at}).state;
    }
    }
    if (validatedCalls.size && !previouslyAccepted && current.found.revision === undefined) throw new OpenAIAgentsProtocolError(409,"This history source cannot bind function validation to a Session revision",undefined,"history_revision_unavailable");
    const result = await deps.sessionEvents.sendSessionEvents({sessionId,events,...(key !== undefined && {idempotencyKey:key}),...(validatedCalls.size && current.found.revision !== undefined && {expectedRevision:current.found.revision})});
    if (result.type === "not_found") return missing();
    if (result.type === "invalid_request") return invalid(result.message);
    if (result.type === "idempotency_conflict" || result.type === "version_conflict") throw new OpenAIAgentsProtocolError(409,result.message);
    return {status:204};
  }
  return { async execute(request) {
    const {operation,params,query,body} = request;
    if (operation === "sessions.create") {
      const command = await deps.mapping.prepareCreate(body);
      const created = await deps.sessions.createSession(command);
      if (created.type !== "created") return invalid(created.message);
      const current = await snapshot(created.session.id);
      return body.stream === true ? {stream:stream(created.session.id,request.signal,true,current)} : {body:current.session};
    }
    if (operation === "sessions.list") {
      const data: AgentSession[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await deps.sessions.listSessions({pageSize:100,order:"asc",cursor,...(typeof query.agent_id === "string" && {agentId:query.agent_id})});
        if (result.type !== "page") return invalid(result.message);
        for (const session of result.page.sessions) {
          try { data.push((await snapshot(session.id)).session); }
          catch (error) {
            // Legacy histories without source order cannot truthfully expose
            // Turns or pending actions. They remain directly inspectable with
            // the explicit 409 limitation but are outside this collection.
            if (!(error instanceof OpenAIAgentsProtocolError) || error.code !== "history_order_unavailable") throw error;
          }
        }
        cursor = result.page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("Native session list repeated its cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return {body:page(data,query,true)};
    }
    const sessionId = params.session_id!;
    if (operation === "sessions.delete") {
      await nativeSession(sessionId);
      if ((await deps.sessions.deleteSession({sessionId})).type !== "deleted") return missing();
      return {body:{id:sessionId,object:"agent.session.deleted",deleted:true}};
    }
    if (operation.startsWith("sessions.artifacts.")) {
      await nativeSession(sessionId);
      if (!deps.resources) throw new OpenAIAgentsProtocolError(501,"This runtime has no immutable artifact publication adapter",undefined,"unsupported_capability");
      return deps.resources.execute(request);
    }
    const current = await snapshot(sessionId);
    if (operation === "sessions.retrieve") return {body:current.session};
    if (operation === "sessions.update") {
      if (Object.hasOwn(body,"metadata")) {
        const result = await deps.sessions.updateSession({sessionId,metadata:await deps.mapping.prepareMetadata(current.native,body.metadata as Record<string,string> | null)});
        if (result.type === "not_found") return missing();
        if (result.type === "invalid_request") return invalid(result.message);
        if (result.type === "version_conflict") throw new OpenAIAgentsProtocolError(409,result.message);
      }
      return {body:(await snapshot(sessionId)).session};
    }
    if (operation === "sessions.events.create") return send(request,current);
    if (operation === "sessions.events.stream") return {stream:stream(sessionId,request.signal,false,current)};
    const state = current.state, child = params.subagent_id;
    if (child && !Object.hasOwn(state.subagents,child)) return missing();
    if (operation === "sessions.subagents.retrieve") return {body:state.subagents[child!]};
    if (operation === "sessions.subagents.list") return {body:page(state.subagentOrder.map(id=>state.subagents[id]!),query,true)};
    if (params.turn_id && (!Object.hasOwn(state.turns,params.turn_id) || child != null && state.turns[params.turn_id]!.subagent_id !== child)) return missing();
    if (operation.endsWith(".turns.retrieve")) return {body:state.turns[params.turn_id!]};
    if (operation.endsWith(".turns.list")) return {body:page(state.turnOrder.map(id=>state.turns[id]!).filter(turn=>!child || turn.subagent_id===child),query,true)};
    if (operation.endsWith(".items.list")) return {body:page(state.itemOrder.filter(id=>state.itemLanes[id]===(child??"root")).map(id=>state.items[id]!).filter(item=>!params.turn_id || item.turn_id===params.turn_id),query)};
    return missing();
  } };
}
