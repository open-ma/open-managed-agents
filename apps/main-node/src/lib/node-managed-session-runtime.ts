import type {
  ArchivedSessionThread,
  SessionThreadEventStreamPort,
  SessionThreadLifecycleCommandPort,
  StreamSessionEvent,
  SubscribeSessionThreadEvents,
  SessionBootstrapEvent,
  SessionEventView,
  SessionRuntimeHistoryApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  AcceptedSessionEvents,
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type {
  SessionLifecycleCommandPort,
  StartSessionExecution,
  StopSessionExecution,
} from "@open-managed-agents/session-runtime-contract/lifecycle";
import type {
  SessionEventStreamPort,
  SubscribeSessionEvents,
} from "@open-managed-agents/session-runtime-contract/stream";
import {
  decodeRuntimeEvent,
  decodeRuntimeProducedSessionEvent,
  RuntimeEventStreamDecoder,
} from "@open-managed-agents/managed-agents-adapters-runtime";
import type {
  SessionRuntimeProjectionApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type {
  SessionRealtimeHub,
  SessionRealtimeWriter,
} from "@open-managed-agents/session-realtime";
import { ScopedSessionMap } from "./scoped-session-map.js";

export type StartNodeManagedSessionRuntime = StartSessionExecution;

export type StopNodeManagedSessionRuntime = StopSessionExecution;

export type AcceptNodeManagedSessionEvents = AcceptedSessionEvents;

export interface ExecuteNodeManagedSessionEvents
  extends AcceptNodeManagedSessionEvents {
  executionFence?: SessionExecutionFence;
}

export type ArchiveNodeManagedSessionThread = ArchivedSessionThread;

export type SubscribeNodeManagedSessionRuntime =
  | SubscribeSessionEvents
  | SubscribeSessionThreadEvents;

export interface NodeManagedSessionRuntimeDriver {
  start(input: StartNodeManagedSessionRuntime): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: ExecuteNodeManagedSessionEvents): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
  subscribe(input: SubscribeNodeManagedSessionRuntime): AsyncIterable<unknown>;
}

export interface NodeManagedSessionRuntimeCoordination
  extends SessionEventDispatchPort
{
  cancelSession(input: {
    workspaceId: string;
    sessionId: string;
    reason: string;
  }): Promise<void>;
}

export interface NodeManagedSessionRuntimeEngine {
  start(
    input: StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: AcceptNodeManagedSessionEvents & {
    executionFence?: SessionExecutionFence;
  }): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
}

export interface DefaultNodeManagedSessionRuntimeDriverDependencies {
  engine: NodeManagedSessionRuntimeEngine;
  realtime: SessionRealtimeHub;
  projectionFor(
    workspaceId: string,
  ): SessionRuntimeProjectionApplicationPort;
}

export interface NodeManagedSessionRunnerAcceptInput
  extends AcceptNodeManagedSessionEvents {
  executionFence?: SessionExecutionFence;
  initialEvents: SessionBootstrapEvent[];
  historyEvents: SessionEventView[];
  output(frame: unknown): Promise<void>;
}

export interface NodeManagedSessionRunner {
  start(input: StartNodeManagedSessionRuntime): Promise<void>;
  stop(input: StopNodeManagedSessionRuntime): Promise<void>;
  accept(input: NodeManagedSessionRunnerAcceptInput): Promise<void>;
  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void>;
}

export interface ApplicationBackedNodeManagedSessionRuntimeEngineDependencies {
  historyFor(workspaceId: string): SessionRuntimeHistoryApplicationPort;
  runner: NodeManagedSessionRunner;
}

export class ApplicationBackedNodeManagedSessionRuntimeEngine
  implements NodeManagedSessionRuntimeEngine
{
  private readonly outputs = new ScopedSessionMap<
    (frame: unknown) => Promise<void>
  >();

  constructor(
    private readonly dependencies: ApplicationBackedNodeManagedSessionRuntimeEngineDependencies,
  ) {}

  async start(
    input: StartNodeManagedSessionRuntime,
    output: (frame: unknown) => Promise<void>,
  ): Promise<void> {
    await this.dependencies.runner.start(input);
    this.outputs.set(input, output);
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    try {
      await this.dependencies.runner.stop(input);
    } finally {
      this.outputs.delete(input);
    }
  }

  async accept(input: AcceptNodeManagedSessionEvents): Promise<void> {
    const output = this.outputs.get(input);
    if (output === undefined) {
      throw new Error(
        `Session ${input.workspaceId}/${input.sessionId} runtime was not started`,
      );
    }
    const history = await this.dependencies
      .historyFor(input.workspaceId)
      .loadSessionRuntimeHistory({ sessionId: input.sessionId });
    if (history.type === "not_found") {
      throw new Error(`Session ${input.sessionId} history was not found`);
    }
    const executionFence = "executionFence" in input && input.executionFence !== null &&
      typeof input.executionFence === "object"
      ? input.executionFence as SessionExecutionFence
      : undefined;
    await this.dependencies.runner.accept({
      ...input,
      ...(executionFence !== undefined ? { executionFence } : {}),
      initialEvents: history.initialEvents,
      historyEvents: history.events,
      output,
    });
  }

  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void> {
    return this.dependencies.runner.archiveThread(input);
  }
}

interface LiveSubscription extends AsyncIterableIterator<unknown> {
  publish(frame: unknown): void;
  close(): void;
}

function createLiveSubscription(onClose: () => void): LiveSubscription {
  const queued: unknown[] = [];
  let pending: ((result: IteratorResult<unknown>) => void) | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
    pending?.({ value: undefined, done: true });
    pending = null;
  };
  return {
    [Symbol.asyncIterator]() { return this; },
    next() {
      const frame = queued.shift();
      if (frame !== undefined) {
        return Promise.resolve({ value: frame, done: false });
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<unknown>>((resolve) => {
        pending = resolve;
      });
    },
    return() {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
    publish(frame) {
      if (closed) return;
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve({ value: frame, done: false });
        return;
      }
      queued.push(frame);
    },
    close,
  };
}

export class DefaultNodeManagedSessionRuntimeDriver
  implements NodeManagedSessionRuntimeDriver
{
  private readonly outputChains = new ScopedSessionMap<Promise<void>>();
  private readonly starts = new ScopedSessionMap<Promise<void>>();
  private readonly executionFences = new ScopedSessionMap<SessionExecutionFence>();
  private readonly realtime: SessionRealtimeHub;

  constructor(
    private readonly dependencies: DefaultNodeManagedSessionRuntimeDriverDependencies,
  ) {
    this.realtime = dependencies.realtime;
  }

  async start(input: StartNodeManagedSessionRuntime): Promise<void> {
    const previous = this.starts.get(input);
    const start = (previous ?? Promise.resolve()).then(() =>
      this.dependencies.engine.start(input, (frame) =>
        this.enqueueOutput(
          input.workspaceId,
          input.sessionId,
          frame,
          this.executionFences.get(input),
        )),
    );
    this.starts.set(input, start);
    try {
      await start;
    } catch (error) {
      if (this.starts.get(input) === start) {
        this.starts.delete(input);
      }
      throw error;
    }
  }

  async stop(input: StopNodeManagedSessionRuntime): Promise<void> {
    try {
      await this.dependencies.engine.stop(input);
      await this.outputChains.get(input);
    } finally {
      this.starts.delete(input);
      this.closeSession(input);
    }
  }

  async accept(input: ExecuteNodeManagedSessionEvents): Promise<void> {
    const fence = input.executionFence;
    if (
      fence !== undefined &&
      (fence.workspaceId !== input.workspaceId ||
        fence.sessionId !== input.sessionId)
    ) {
      throw new Error("Session execution fence scope does not match runtime input");
    }
    if (fence !== undefined) this.executionFences.set(input, fence);
    try {
      await this.start({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        session: input.session,
        environment: input.environment,
        initialEvents: [],
      });
      const { executionFence: _executionFence, ...accepted } = input;
      await this.dependencies.engine.accept({
        ...accepted,
        ...(fence !== undefined && { executionFence: fence }),
      });
      await this.outputChains.get(input);
    } finally {
      if (fence !== undefined && this.executionFences.get(input) === fence) {
        this.executionFences.delete(input);
      }
    }
  }

  archiveThread(input: ArchiveNodeManagedSessionThread): Promise<void> {
    return this.dependencies.engine.archiveThread(input);
  }

  subscribe(input: SubscribeNodeManagedSessionRuntime): AsyncIterable<unknown> {
    let writerClosed = false;
    let detach = () => {};
    const subscription = createLiveSubscription(() => {
      writerClosed = true;
      detach();
    });
    const writer: SessionRealtimeWriter = {
      get closed() { return writerClosed; },
      write: (frame) => { subscription.publish(frame.event); },
      close: () => {
        writerClosed = true;
        subscription.close();
      },
    };
    detach = this.realtime.attach({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      writer,
    });
    return subscription;
  }

  private async handleOutput(
    workspaceId: string,
    sessionId: string,
    frame: unknown,
    executionFence?: SessionExecutionFence,
  ): Promise<void> {
    const event = decodeRuntimeProducedSessionEvent(frame);
    if (event !== null) {
      const projection = this.dependencies.projectionFor(workspaceId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const projected = await projection.recordSessionRuntimeEvents({
          sessionId,
          events: [event],
          ...(executionFence !== undefined && { executionFence }),
        });
        if (projected.type === "recorded") break;
        if (projected.type === "not_found") return;
        if (projected.type === "execution_fence_lost") {
          throw new Error(
            `Session ${workspaceId}/${sessionId} execution fence was lost`,
          );
        }
        if (attempt === 2) throw new Error(projected.message);
      }
    }
    const decoded = decodeRuntimeEvent(
      frame,
      new Set(["agent.message", "agent.thinking"]),
    );
    const sequence = frame !== null && typeof frame === "object" &&
        "seq" in frame && typeof frame.seq === "number"
      ? frame.seq
      : undefined;
    for (const event of decoded) {
      this.realtime.publish({
        workspaceId,
        sessionId,
        frame: { event, ...(sequence !== undefined && { sequence }) },
      });
    }
  }

  private enqueueOutput(
    workspaceId: string,
    sessionId: string,
    frame: unknown,
    executionFence?: SessionExecutionFence,
  ): Promise<void> {
    const scope = { workspaceId, sessionId };
    const previous = this.outputChains.get(scope) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handleOutput(
        workspaceId,
        sessionId,
        frame,
        executionFence,
      ));
    this.outputChains.set(scope, current);
    current.then(
      () => this.removeOutputChain(scope, current),
      () => this.removeOutputChain(scope, current),
    );
    return current;
  }

  private removeOutputChain(
    scope: { workspaceId: string; sessionId: string },
    chain: Promise<void>,
  ): void {
    if (this.outputChains.get(scope) === chain) {
      this.outputChains.delete(scope);
    }
  }

  private closeSession(scope: { workspaceId: string; sessionId: string }): void {
    this.realtime.closeSession(scope);
  }
}

export class NodeManagedSessionRuntimeAdapter
  implements
    SessionLifecycleCommandPort,
    SessionEventDispatchPort,
    SessionThreadLifecycleCommandPort,
    SessionEventStreamPort,
    SessionThreadEventStreamPort
{
  constructor(
    private readonly driver: NodeManagedSessionRuntimeDriver,
    private readonly coordination?: NodeManagedSessionRuntimeCoordination,
  ) {}

  async sessionStarted(input: StartSessionExecution): Promise<void> {
    if (this.coordination !== undefined) return;
    await this.driver.start(input);
  }

  async sessionStopped(input: StopSessionExecution): Promise<void> {
    if (this.coordination !== undefined) {
      await this.coordination.cancelSession({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        reason: `session_${input.reason}`,
      });
    }
    await this.driver.stop(input);
  }

  async sessionEventsAccepted(input: AcceptedSessionEvents): Promise<void> {
    await (this.coordination ?? {
      sessionEventsAccepted: (accepted: AcceptedSessionEvents) =>
        this.driver.accept(accepted),
    }).sessionEventsAccepted(input);
  }

  async sessionThreadArchived(input: ArchivedSessionThread): Promise<void> {
    await this.driver.archiveThread(input);
  }

  subscribe(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    return this.stream(input);
  }

  private async *stream(
    input: SubscribeSessionEvents | SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent> {
    const deltaTypes = new Set(input.deltaEventTypes ?? []);
    const decoder = new RuntimeEventStreamDecoder(deltaTypes);
    const deltaEventIds = new Set<string>();
    for await (const raw of this.driver.subscribe(input)) {
      if (
        "threadId" in input &&
        (
          raw === null ||
          typeof raw !== "object" ||
          (!(("sessionThreadId" in raw && raw.sessionThreadId === input.threadId) ||
            ("session_thread_id" in raw && raw.session_thread_id === input.threadId)))
        )
      ) continue;
      if (
        raw !== null && typeof raw === "object" &&
        "type" in raw && raw.type === "event_start" &&
        "event" in raw && raw.event !== null && typeof raw.event === "object" &&
        "id" in raw.event && typeof raw.event.id === "string" &&
        "type" in raw.event &&
        (raw.event.type === "agent.message" || raw.event.type === "agent.thinking")
      ) {
        if (deltaTypes.has(raw.event.type)) {
          deltaEventIds.add(raw.event.id);
          yield raw as StreamSessionEvent;
        }
        continue;
      }
      if (
        raw !== null && typeof raw === "object" &&
        "type" in raw && raw.type === "event_delta" &&
        "eventId" in raw && typeof raw.eventId === "string"
      ) {
        if (deltaEventIds.has(raw.eventId)) yield raw as StreamSessionEvent;
        continue;
      }
      for (const event of decoder.decode(raw)) yield event;
    }
  }
}
