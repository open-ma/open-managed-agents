import type {
  AcpRuntime,
  AcpSession,
  SessionOptions,
} from "@open-managed-agents/acp-runtime";
import type { SessionHostEvent } from "@openma/common/session-kernel";
import type {
  ManagedAgentsSessionCheckpoint,
  ManagedAgentsSessionCheckpointStore,
} from "./checkpoint.js";

export interface ManagedAgentsSessionHostDependencies {
  runtime: AcpRuntime;
  emit(event: SessionHostEvent): void;
  scheduler?: ManagedAgentsRuntimeScheduler;
  /** Grace after ACP session/cancel before a stuck child is disposed. When
   * omitted the host preserves the legacy abort-only behavior. */
  cancelGraceMs?: number;
  checkpointStore?: ManagedAgentsSessionCheckpointStore;
  /** Unique per running host process/isolate. Required with a checkpoint
   * store so generations can fence stale restored copies. */
  hostInstanceId?: string;
}

export interface ManagedAgentsRuntimeScheduler {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ManagedAgentsDrainOptions {
  deadlineMs: number;
  pollIntervalMs?: number;
  abortGraceMs?: number;
  onProgress?(activeTurns: number, msLeft: number): void;
}

export interface ManagedAgentsDrainReport {
  initialTurns: number;
  abortedTurns: number;
  sessions: number;
}

export const systemRuntimeScheduler: ManagedAgentsRuntimeScheduler = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ManagedAgentsSessionStartInput {
  sessionId: string;
  options: SessionOptions;
}

export interface ManagedAgentsSessionPromptInput {
  sessionId: string;
  turnId: string;
  text: string;
}

interface ActiveSession {
  acp: AcpSession;
  turns: Map<string, AbortController>;
  checkpoint?: ManagedAgentsSessionCheckpoint;
}

export class ManagedAgentsSessionHost {
  readonly #runtime: AcpRuntime;
  readonly #emit: (event: SessionHostEvent) => void;
  readonly #scheduler: ManagedAgentsRuntimeScheduler;
  readonly #cancelGraceMs: number | undefined;
  readonly #checkpointStore: ManagedAgentsSessionCheckpointStore | undefined;
  readonly #hostInstanceId: string | undefined;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #resumeSessionIds = new Map<string, string>();
  #draining = false;

  constructor(dependencies: ManagedAgentsSessionHostDependencies) {
    this.#runtime = dependencies.runtime;
    this.#emit = dependencies.emit;
    this.#scheduler = dependencies.scheduler ?? systemRuntimeScheduler;
    this.#cancelGraceMs = dependencies.cancelGraceMs;
    this.#checkpointStore = dependencies.checkpointStore;
    this.#hostInstanceId = dependencies.hostInstanceId;
    if (this.#checkpointStore && !this.#hostInstanceId) {
      throw new Error("hostInstanceId is required when checkpointStore is configured");
    }
  }

  has(sessionId: string): boolean {
    return this.#liveSession(sessionId) !== undefined;
  }

  sessionCount(): number {
    this.#pruneDeadSessions();
    return this.#sessions.size;
  }

  announce(sessionId: string): boolean {
    const session = this.#liveSession(sessionId);
    if (!session) return false;
    this.#emit({
      type: "session.ready",
      sessionId,
      acpSessionId: session.acp.acpSessionId,
    });
    return true;
  }

  announceAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) {
      const session = this.#liveSession(sessionId);
      if (!session) continue;
      this.#emit({
        type: "session.ready",
        sessionId,
        acpSessionId: session.acp.acpSessionId,
      });
    }
  }

  activeTurnCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) count += session.turns.size;
    return count;
  }

  async start(input: ManagedAgentsSessionStartInput): Promise<void> {
    if (this.#draining) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        message: "runtime is draining; retry on another runtime",
      });
      return;
    }
    if (this.announce(input.sessionId)) return;

    let claimedCheckpoint: ManagedAgentsSessionCheckpoint | undefined;
    let durableCheckpoint: ManagedAgentsSessionCheckpoint | null = null;
    if (this.#checkpointStore) {
      try {
        durableCheckpoint = await this.#checkpointStore.load(input.sessionId);
        const nextGeneration = (durableCheckpoint?.generation ?? 0) + 1;
        claimedCheckpoint = {
          sessionId: input.sessionId,
          generation: nextGeneration,
          ownerId: this.#hostInstanceId!,
          acpSessionId: durableCheckpoint?.acpSessionId ?? "",
          phase: "recovering",
          updatedAt: this.#scheduler.now(),
          ...(durableCheckpoint?.lastCompletedTurnId
            ? { lastCompletedTurnId: durableCheckpoint.lastCompletedTurnId }
            : {}),
        };
        const claimed = await this.#checkpointStore.compareAndSet({
          expectedGeneration: durableCheckpoint?.generation ?? null,
          checkpoint: claimedCheckpoint,
        });
        if (!claimed) {
          this.#emitLeaseLost(input.sessionId);
          return;
        }
      } catch (error) {
        this.#emit({
          type: "session.error",
          sessionId: input.sessionId,
          message: `session checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }

    const recoverySessionId = this.#resumeSessionIds.get(input.sessionId)
      ?? durableCheckpoint?.acpSessionId;
    const options = recoverySessionId && !input.options.resumeAcpSessionId
      ? { ...input.options, resumeAcpSessionId: recoverySessionId }
      : input.options;
    let session: AcpSession;
    try {
      session = await this.#runtime.start(options);
    } catch (error) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#sessions.set(input.sessionId, {
      acp: session,
      turns: new Map(),
      ...(claimedCheckpoint ? { checkpoint: claimedCheckpoint } : {}),
    });

    if (claimedCheckpoint && this.#checkpointStore) {
      const readyCheckpoint: ManagedAgentsSessionCheckpoint = {
        ...claimedCheckpoint,
        acpSessionId: session.acpSessionId,
        phase: "ready",
        updatedAt: this.#scheduler.now(),
      };
      const retained = await this.#checkpointStore.compareAndSet({
        expectedGeneration: claimedCheckpoint.generation,
        checkpoint: readyCheckpoint,
      }).catch(() => false);
      if (!retained) {
        this.#sessions.delete(input.sessionId);
        await session.dispose().catch(() => undefined);
        this.#emitLeaseLost(input.sessionId);
        return;
      }
      this.#sessions.get(input.sessionId)!.checkpoint = readyCheckpoint;
    }
    this.#resumeSessionIds.delete(input.sessionId);
    this.#emit({
      type: "session.ready",
      sessionId: input.sessionId,
      acpSessionId: session.acpSessionId,
    });
  }

  async prompt(input: ManagedAgentsSessionPromptInput): Promise<void> {
    const session = this.#liveSession(input.sessionId);
    if (!session) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: "no such session",
      });
      return;
    }
    if (!await this.#retainGenerationLease(input.sessionId, session)) return;
    const controller = new AbortController();
    session.turns.set(input.turnId, controller);
    let promptError: string | undefined;
    try {
      for await (const event of session.acp.prompt(input.text, {
        abortSignal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        const sentinel = event as {
          type?: unknown;
          error?: unknown;
        } | null;
        if (sentinel?.type === "promptComplete") {
          this.#emit({
            type: "session.event",
            sessionId: input.sessionId,
            turnId: input.turnId,
            event,
          });
          continue;
        }
        if (sentinel?.type === "promptError") {
          promptError = typeof sentinel.error === "string"
            ? sentinel.error
            : "ACP prompt error (no message)";
          continue;
        }
        this.#emit({
          type: "session.event",
          sessionId: input.sessionId,
          turnId: input.turnId,
          event,
        });
      }
      this.#emit(promptError
        ? {
            type: "session.error",
            sessionId: input.sessionId,
            turnId: input.turnId,
            message: promptError,
          }
        : {
            type: "session.complete",
            sessionId: input.sessionId,
            turnId: input.turnId,
          });
    } catch (error) {
      this.#emit({
        type: "session.error",
        sessionId: input.sessionId,
        turnId: input.turnId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      session.turns.delete(input.turnId);
    }
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) {
      for (const controller of session.turns.values()) controller.abort();
      await session.acp.dispose().catch(() => undefined);
      this.#sessions.delete(sessionId);
    }
    this.#resumeSessionIds.delete(sessionId);
    if (this.#checkpointStore) {
      await this.#checkpointStore.delete({
        sessionId,
        ...(session?.checkpoint
          ? {
              expectedGeneration: session.checkpoint.generation,
              ownerId: session.checkpoint.ownerId,
            }
          : {}),
      }).catch(() => undefined);
    }
    this.#emit({ type: "session.disposed", sessionId });
  }

  async disposeAll(): Promise<void> {
    const sessions = [...this.#sessions.entries()];
    await Promise.all(sessions.map(async ([sessionId, session]) => {
      for (const controller of session.turns.values()) controller.abort();
      await session.acp.dispose().catch(() => undefined);
      this.#sessions.delete(sessionId);
    }));
  }

  async drain(options: ManagedAgentsDrainOptions): Promise<ManagedAgentsDrainReport> {
    this.#draining = true;
    const initialTurns = this.activeTurnCount();
    const sessions = this.sessionCount();
    const startedAt = this.#scheduler.now();
    const pollIntervalMs = options.pollIntervalMs ?? 200;

    while (this.activeTurnCount() > 0) {
      const elapsed = this.#scheduler.now() - startedAt;
      if (elapsed >= options.deadlineMs) break;
      const msLeft = options.deadlineMs - elapsed;
      options.onProgress?.(this.activeTurnCount(), msLeft);
      await this.#scheduler.sleep(Math.min(pollIntervalMs, msLeft));
    }

    let abortedTurns = 0;
    for (const session of this.#sessions.values()) {
      for (const controller of session.turns.values()) {
        if (!controller.signal.aborted) {
          controller.abort();
          abortedTurns += 1;
        }
      }
    }
    if (abortedTurns > 0 && (options.abortGraceMs ?? 2_000) > 0) {
      await this.#scheduler.sleep(options.abortGraceMs ?? 2_000);
    }
    await this.disposeAll();
    return { initialTurns, abortedTurns, sessions };
  }

  async cancel(sessionId: string, turnId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    const controller = session?.turns.get(turnId);
    if (!session || !controller) return;
    controller.abort();
    if (this.#cancelGraceMs === undefined) return;

    await this.#scheduler.sleep(this.#cancelGraceMs);
    if (this.#sessions.get(sessionId) !== session || !session.turns.has(turnId)) {
      return;
    }
    this.#rememberForRecovery(sessionId, session);
    this.#sessions.delete(sessionId);
    await session.acp.dispose().catch(() => undefined);
  }

  #liveSession(sessionId: string): ActiveSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.acp.isAlive()) return session;
    this.#rememberForRecovery(sessionId, session);
    this.#sessions.delete(sessionId);
    void session.acp.dispose().catch(() => undefined);
    return undefined;
  }

  #pruneDeadSessions(): void {
    for (const sessionId of [...this.#sessions.keys()]) {
      this.#liveSession(sessionId);
    }
  }

  #rememberForRecovery(sessionId: string, session: ActiveSession): void {
    if (session.acp.acpSessionId) {
      this.#resumeSessionIds.set(sessionId, session.acp.acpSessionId);
    }
    if (session.checkpoint && this.#checkpointStore) {
      const recovering: ManagedAgentsSessionCheckpoint = {
        ...session.checkpoint,
        acpSessionId: session.acp.acpSessionId,
        phase: "recovering",
        updatedAt: this.#scheduler.now(),
      };
      void this.#checkpointStore.compareAndSet({
        expectedGeneration: session.checkpoint.generation,
        checkpoint: recovering,
      }).then((saved) => {
        if (saved) session.checkpoint = recovering;
      }).catch(() => undefined);
    }
  }

  async #retainGenerationLease(
    sessionId: string,
    session: ActiveSession,
  ): Promise<boolean> {
    if (!session.checkpoint || !this.#checkpointStore) return true;
    const retainedCheckpoint: ManagedAgentsSessionCheckpoint = {
      ...session.checkpoint,
      updatedAt: this.#scheduler.now(),
    };
    const retained = await this.#checkpointStore.compareAndSet({
      expectedGeneration: session.checkpoint.generation,
      checkpoint: retainedCheckpoint,
    }).catch(() => false);
    if (retained) {
      session.checkpoint = retainedCheckpoint;
      return true;
    }
    if (this.#sessions.get(sessionId) === session) {
      this.#sessions.delete(sessionId);
    }
    await session.acp.dispose().catch(() => undefined);
    this.#emitLeaseLost(sessionId);
    return false;
  }

  #emitLeaseLost(sessionId: string): void {
    this.#emit({
      type: "session.error",
      sessionId,
      message: "runtime lost the session generation lease",
    });
  }
}
