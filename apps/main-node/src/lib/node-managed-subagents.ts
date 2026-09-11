import { randomUUID } from "node:crypto";
import { withSandboxExecutionGuard, type SandboxExecutor } from "@open-managed-agents/sandbox";
import type { Session, SessionEventView, SessionThread } from "@open-managed-agents/managed-agents-application";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { ManagedNodeHarnessRuntime } from "./node-managed-harness-runtime.js";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

export interface ManagedNodeCreateSubagent {
  agentId?: string;
  name?: string;
  instructions?: string;
  message?: string;
  parentToolUseId?: string;
}

export interface ManagedNodeSubagentState {
  threadId: string;
  status: "idle" | "running" | "completed" | "interrupted" | "closed" | "failed";
  output?: string;
}

export interface ManagedNodeSubagentControl {
  create(input: ManagedNodeCreateSubagent): Promise<ManagedNodeSubagentState>;
  send(input: { threadId: string; message: string }): Promise<ManagedNodeSubagentState>;
  wait(input: { threadIds: string[]; timeoutMs?: number }): Promise<{ subagents: ManagedNodeSubagentState[]; timedOut: boolean }>;
  interrupt(input: { threadId: string }): Promise<ManagedNodeSubagentState>;
  close(input: { threadId: string }): Promise<ManagedNodeSubagentState>;
  resume(input: { threadId: string; message?: string }): Promise<ManagedNodeSubagentState>;
}

/** Existing native Thread storage owns identity and the immutable agent snapshot.
 * Native events remain the source for the conversation and execution status. */
export interface ManagedNodeSubagentThreads {
  insert(input: { workspaceId: string; thread: SessionThread; executionFence?: SessionExecutionFence }): Promise<SessionThread>;
  find(input: { workspaceId: string; sessionId: string; threadId: string }): Promise<SessionThread | null>;
}

export interface ManagedNodeSubagentPolicy {
  enabled: boolean;
  maxConcurrentSubagents?: number;
}

interface Child {
  thread: SessionThread;
  session: Session;
  events: SessionEventView[];
  state: ManagedNodeSubagentState;
  controller?: AbortController;
  running?: Promise<void>;
  pending: Array<{ id: string; message: string }>;
  paused?: boolean;
}

interface SubagentsInput {
  workspaceId: string;
  session: Session;
  parentThreadId: string;
  sandbox: SandboxExecutor;
  abortSignal: AbortSignal;
  executionFence?: SessionExecutionFence;
  historyEvents: SessionEventView[];
  threads: ManagedNodeSubagentThreads;
  policy: ManagedNodeSubagentPolicy;
  resolveSession?(request: ManagedNodeCreateSubagent): Promise<Session>;
  run(input: { session: Session; runtime: ManagedNodeHarnessRuntime; sandbox: SandboxExecutor }): Promise<void>;
  output(frame: unknown): Promise<void>;
  clock: { now(): Date };
  ids: { nextEventId(): string };
}

export function managedEventThread(event: SessionEventView): string {
  return (event as SessionEventView & { sessionThreadId?: string | null }).sessionThreadId ?? "sthr_primary";
}

function childHistory(events: SessionEventView[]): SessionEventView[] {
  return events.map((event) => event.type === "agent.thread_message_received"
    ? { id: event.id, type: "user.message", content: event.content, processedAt: event.processedAt }
    : event);
}

function lastOutput(events: SessionEventView[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "agent.message") return event.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return undefined;
}

/** A turn-local execution owner, backed by the Session's native threads/events.
 * Child work never escapes the parent's execution fence. */
export class ManagedNodeSubagents implements ManagedNodeSubagentControl {
  private readonly children = new Map<string, Child>();
  private pendingCreates = 0;
  private outputChain: Promise<void> = Promise.resolve();
  private mutations: Promise<void> = Promise.resolve();
  private readonly loads = new Map<string, Promise<Child>>();
  private readonly facts: SessionEventView[];

  constructor(private readonly input: SubagentsInput) {
    this.facts = [...input.historyEvents];
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertActive(): void {
    this.input.abortSignal.throwIfAborted();
  }

  private assertCapacity(): void {
    const running = [...this.children.values()].filter((child) => child.running !== undefined).length;
    if (running + this.pendingCreates >= (this.input.policy.maxConcurrentSubagents ?? 8)) {
      throw new Error("Subagent concurrency limit reached");
    }
  }

  private snapshot(child: Child): ManagedNodeSubagentState {
    return { ...child.state };
  }

  private write(child: Child, raw: Record<string, unknown>, threadId = child.thread.id): Promise<void> {
    const frame = { ...raw, session_thread_id: threadId };
    const event = decodeRuntimeProducedSessionEvent(frame);
    const operation = this.outputChain.then(async () => {
      await this.input.output(frame);
      if (event !== null) {
        this.facts.push(event);
        if (threadId === child.thread.id) child.events.push(event);
      }
    });
    this.outputChain = operation;
    return operation;
  }

  private emit(child: Child, event: Record<string, unknown>): Promise<void> {
    return this.write(child, {
      id: this.input.ids.nextEventId(),
      processed_at: this.input.clock.now().toISOString(),
      ...event,
    });
  }

  create(request: ManagedNodeCreateSubagent): Promise<ManagedNodeSubagentState> {
    return this.mutate(() => this.createChild(request));
  }

  private async createChild(request: ManagedNodeCreateSubagent): Promise<ManagedNodeSubagentState> {
    this.assertActive();
    this.assertCapacity();
    this.pendingCreates += 1;
    try {
      const session = this.input.resolveSession !== undefined
        ? await this.input.resolveSession(request)
        : this.defaultSession(request);
      this.assertActive();
      const now = this.input.clock.now().toISOString();
      const { multiagent: _multiagent, ...agent } = session.agent;
      const thread = await this.input.threads.insert({ workspaceId: this.input.workspaceId,
        ...(this.input.executionFence !== undefined && { executionFence: this.input.executionFence }), thread: {
        id: `sthr_${randomUUID()}`, sessionId: this.input.session.id,
        parentThreadId: this.input.parentThreadId, agent: { ...agent, type: "agent" },
        archivedAt: null, createdAt: now, updatedAt: now, stats: null, usage: null, status: "idle",
      } });
      this.assertActive();
      const child: Child = { thread, session, events: [], pending: [], state: { threadId: thread.id, status: "idle" } };
      this.children.set(thread.id, child);
      await this.emit(child, { type: "session.thread_created", agent_name: session.agent.name,
        parent_thread_id: this.input.parentThreadId,
        ...(request.parentToolUseId !== undefined && { parent_tool_use_id: request.parentToolUseId }),
        ...(request.instructions !== undefined && { content: [{ type: "text", text: request.instructions }] }),
      });
      if (request.message !== undefined) {
        await this.enqueueMessage(child, request.message);
        this.startChild(child);
      }
      return this.snapshot(child);
    } finally {
      this.pendingCreates -= 1;
    }
  }

  private defaultSession(request: ManagedNodeCreateSubagent): Session {
    let agent = structuredClone(this.input.session.agent);
    if (request.agentId !== undefined && request.agentId !== "general") {
      const configured = agent.multiagent?.agents.find((candidate) => candidate.type === "agent" && candidate.id === request.agentId);
      if (configured?.type !== "agent") throw new Error(`Subagent ${request.agentId} is not in the Session roster`);
      const { type: _type, ...snapshot } = configured;
      agent = { ...snapshot, multiagent: null };
    }
    return { ...this.input.session, agent: { ...agent, multiagent: null,
      name: request.name ?? agent.name, system: request.instructions ?? agent.system } };
  }

  private child(threadId: string): Promise<Child> {
    const existing = this.children.get(threadId);
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = this.loads.get(threadId);
    if (pending !== undefined) return pending;
    const load = this.loadChild(threadId);
    this.loads.set(threadId, load);
    void load.finally(() => this.loads.delete(threadId)).catch(() => undefined);
    return load;
  }

  private async loadChild(threadId: string): Promise<Child> {
    const thread = await this.input.threads.find({ workspaceId: this.input.workspaceId, sessionId: this.input.session.id, threadId });
    if (thread === null || thread.parentThreadId !== this.input.parentThreadId || thread.agent.type !== "agent") {
      throw new Error(`Subagent ${threadId} was not found under the current parent`);
    }
    if (thread.archivedAt !== null) throw new Error(`Subagent ${threadId} is archived`);
    const { type: _type, ...agent } = thread.agent;
    const events = this.facts.filter((event) => managedEventThread(event) === threadId);
    let status: ManagedNodeSubagentState["status"] = "idle";
    for (const event of events) {
      if (event.type === "session.thread_status_terminated") status = "closed";
      if (event.type === "session.thread_status_running") status = "interrupted"; // Previous process cannot still own this turn.
      if (event.type === "session.thread_status_idle") status = (event as typeof event & { interrupted?: boolean }).interrupted ? "interrupted" : status === "failed" ? "failed" : "completed";
      if (event.type === "session.error") status = "failed";
    }
    const delivered = new Set(events.flatMap((event) => event.type === "agent.thread_message_received" && event.fromMessageId ? [event.fromMessageId] : []));
    const pending = this.facts.flatMap((event) => event.type === "agent.thread_message_sent" && event.toSessionThreadId === threadId && !delivered.has(event.id)
      ? [{ id: event.id, message: event.content.filter((block) => block.type === "text").map((block) => block.text).join("") }] : []);
    const child: Child = { thread, events, pending, session: { ...this.input.session, agent: { ...agent, multiagent: null } },
      state: { threadId, status, output: lastOutput(events) } };
    this.children.set(threadId, child);
    return child;
  }

  send(input: { threadId: string; message: string }): Promise<ManagedNodeSubagentState> {
    return this.mutate(() => this.sendMessage(input));
  }

  private async sendMessage(input: { threadId: string; message: string }): Promise<ManagedNodeSubagentState> {
    this.assertActive();
    const child = await this.child(input.threadId);
    if (child.state.status === "closed") throw new Error(`Subagent ${input.threadId} is closed; resume it before sending input`);
    if (child.running === undefined) this.assertCapacity();
    await this.enqueueMessage(child, input.message);
    if (child.running === undefined) this.startChild(child);
    return this.snapshot(child);
  }

  private async enqueueMessage(child: Child, message: string): Promise<void> {
    const id = this.input.ids.nextEventId();
    await this.write(child, { id, type: "agent.thread_message_sent",
      processed_at: this.input.clock.now().toISOString(), to_session_thread_id: child.thread.id,
      to_agent_name: child.session.agent.name, content: [{ type: "text", text: message }],
    }, this.input.parentThreadId);
    child.pending.push({ id, message });
  }

  private startChild(child: Child): void {
    this.assertActive();
    child.paused = false;
    const runTurn = async (): Promise<void> => {
      const controller = new AbortController();
      child.controller = controller;
      child.state = { threadId: child.thread.id, status: "running" };
      const abortFromParent = () => controller.abort(this.input.abortSignal.reason);
      this.input.abortSignal.addEventListener("abort", abortFromParent, { once: true });
      try {
        const pending = child.pending[0];
        if (pending !== undefined) {
          await this.emit(child, { type: "agent.thread_message_received",
            from_session_thread_id: this.input.parentThreadId, from_agent_name: this.input.session.agent.name,
            from_message_id: pending.id, content: [{ type: "text", text: pending.message }] });
          child.pending.shift();
        }
        await this.emit(child, { type: "session.thread_status_running", agent_name: child.session.agent.name });
        controller.signal.throwIfAborted();
        const sandbox = withSandboxExecutionGuard(this.input.sandbox, { signal: controller.signal });
        const runtime = new ManagedNodeHarnessRuntime({ initialEvents: [], events: childHistory(child.events),
          sandbox, abortSignal: controller.signal, clock: this.input.clock, ids: this.input.ids,
          output: (raw) => {
            const frame = raw as Record<string, unknown>;
            const type = typeof frame.type === "string" && frame.type.startsWith("session.status_")
              ? frame.type.replace("session.status_", "session.thread_status_") : frame.type;
            return this.write(child, { ...frame, type,
              ...(typeof type === "string" && type.startsWith("session.thread_status_") && { agent_name: child.session.agent.name }) });
          },
        });
        try { await this.input.run({ session: child.session, runtime, sandbox }); }
        finally { await runtime.drain(); }
        child.state = { threadId: child.thread.id, status: controller.signal.aborted ? "interrupted" : "completed", output: lastOutput(child.events) };
      } catch (error) {
        child.state = { threadId: child.thread.id, status: controller.signal.aborted ? "interrupted" : "failed" };
        if (!controller.signal.aborted) await this.emit(child, { type: "session.error", error: {
          type: "unknown_error", retry_status: "terminal", message: error instanceof Error ? error.message : String(error),
        } });
      } finally {
        this.input.abortSignal.removeEventListener("abort", abortFromParent);
        await this.emit(child, { type: "session.thread_status_idle", agent_name: child.session.agent.name,
          stop_reason: { type: "end_turn" }, ...(controller.signal.aborted && { interrupted: true }) });
        child.controller = undefined;
      }
    };
    child.running = (async () => {
      do { await runTurn(); }
      while (child.pending.length > 0 && !child.paused && !this.input.abortSignal.aborted && child.state.status !== "failed");
    })().finally(() => { child.running = undefined; });
    // A child failure is returned through its status. Persistence failures must
    // still reach the parent fence barrier without an unhandled rejection.
    void child.running.catch(() => undefined);
  }

  async wait(input: { threadIds: string[]; timeoutMs?: number }): Promise<{ subagents: ManagedNodeSubagentState[]; timedOut: boolean }> {
    this.assertActive();
    if (input.threadIds.length === 0) throw new Error("At least one subagent is required");
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 0)) throw new Error("Subagent wait timeout must be non-negative");
    const children = await Promise.all(input.threadIds.map((id) => this.child(id)));
    let timedOut = false;
    if (children.every((child) => child.running !== undefined)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const waits = children.map((child) => child.running!);
        if (input.timeoutMs !== undefined) waits.push(new Promise<void>((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, input.timeoutMs); }));
        await Promise.race(waits);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return { subagents: children.map((child) => this.snapshot(child)), timedOut };
  }

  interrupt(input: { threadId: string }): Promise<ManagedNodeSubagentState> {
    return this.mutate(() => {
      this.assertActive();
      return this.interruptChild(input);
    });
  }

  private async interruptChild(input: { threadId: string }): Promise<ManagedNodeSubagentState> {
    const child = await this.child(input.threadId);
    child.paused = true;
    child.controller?.abort();
    await child.running;
    return this.snapshot(child);
  }

  close(input: { threadId: string }): Promise<ManagedNodeSubagentState> {
    return this.mutate(() => {
      this.assertActive();
      return this.closeChild(input);
    });
  }

  private async closeChild(input: { threadId: string }): Promise<ManagedNodeSubagentState> {
    const child = await this.child(input.threadId);
    await this.interruptChild(input);
    if (child.state.status !== "closed") {
      await this.emit(child, { type: "session.thread_status_terminated", agent_name: child.session.agent.name });
      child.state = { ...child.state, status: "closed" };
    }
    return this.snapshot(child);
  }

  resume(input: { threadId: string; message?: string }): Promise<ManagedNodeSubagentState> {
    return this.mutate(() => this.resumeChild(input));
  }

  private async resumeChild(input: { threadId: string; message?: string }): Promise<ManagedNodeSubagentState> {
    this.assertActive();
    const child = await this.child(input.threadId);
    if (child.running !== undefined) {
      if (input.message !== undefined) await this.enqueueMessage(child, input.message);
      return this.snapshot(child);
    }
    if (input.message !== undefined || child.pending.length > 0) {
      this.assertCapacity();
      if (input.message !== undefined) await this.enqueueMessage(child, input.message);
      this.startChild(child);
    } else {
      await this.emit(child, { type: "session.thread_status_idle", agent_name: child.session.agent.name, stop_reason: { type: "end_turn" } });
      child.state = { ...child.state, status: "idle" };
    }
    return this.snapshot(child);
  }

  async drain(): Promise<void> {
    await this.mutations;
    await Promise.all([...this.children.values()].map((child) => child.running));
    await this.outputChain;
  }

  /** The application has already archived the native Thread record. Only a
   * live execution needs cancellation; an inactive archived row is not loaded. */
  async archiveThread(threadId: string): Promise<void> {
    const child = this.children.get(threadId);
    if (child === undefined) return;
    await this.mutate(() => this.closeChild({ threadId }));
  }
}
