// SessionStateMachine — single source for turn lifecycle on both CF and
// Node. Phase 2 of the unified-runtime plan: Node adopts this; Phase 3
// CF SessionDO becomes a thin shell that constructs one of these.
//
// Surface (callable from per-platform shell):
//
//   runHarnessTurn(agentId, userMessage)
//     beginTurn → harness.run → endTurn. The whole body is the
//     extracted-and-generalised version of what apps/main-node ran
//     inline before; the same body will replace the CF SessionDO's
//     drainEventQueue+turn-runtime stack in Phase 3.
//
//   onWake()
//     Detect orphan turns (sessions row marked 'running' with a
//     turn_id we don't recognise as our own active turn) and reconcile
//     them via recoverInterruptedState. Called from:
//       - CF DO alarm() (every 30s while a turn is in flight, and on
//         cold start when a request hits an evicted DO)
//       - Node SessionRegistry.bootstrap() at process start
//       - Anywhere a stale-state hint is useful (e.g. an SSE reconnect)
//
//   destroy()
//     Mark the session destroyed. End-of-life signal for graceful
//     shutdown.
//
// Per-platform polymorphism is entirely in the RuntimeAdapter the
// machine holds (one impl, both platforms via SqlClient + the optional
// hintTurnInFlight callback).

import { nanoid } from "nanoid";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import { recoverInterruptedState } from "./recovery";
import type { OrphanTurn, RuntimeAdapter, TurnId } from "./ports";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

/**
 * Pluggable harness — both CF and Node want the same default-loop
 * harness, but the machine doesn't import it directly so we keep the
 * package's dep graph small (no `@open-managed-agents/agent` dep).
 *
 * The shell wires this with:
 *   buildHarness: () => new DefaultHarness()
 *   buildContext: () => HarnessContext  // model + tools + system + ...
 */
export interface HarnessRunFn {
  (ctx: unknown): Promise<void>;
}

export interface SessionMachineDeps {
  sessionId: string;
  tenantId: string;

  /** Single shared adapter for I/O. */
  adapter: RuntimeAdapter;

  /** Per-session sandbox. Constructed by the shell so it can pick the
   *  backend (LocalSubprocess / E2B / Daytona / CloudflareSandbox) and
   *  inject sessionId-scoped paths.  */
  sandbox: SandboxExecutor;

  /** Look up the agent config. CF reads from a snapshot or the agents
   *  store; Node reads from agentsService. */
  loadAgent(agentId: string): Promise<AgentConfig | null>;

  /** Bind a memory store into the sandbox. Phase 2 keeps the loop in
   *  the shell to avoid pulling memory-store types into this package;
   *  the shell calls sandbox.mountMemoryStore directly via sandbox. */
  mountMemoryStores?(opts: { sandbox: SandboxExecutor }): Promise<void>;

  /** Build the LanguageModel for this turn. CF reads env from
   *  bindings; Node from process.env. */
  buildModel(agent: AgentConfig): LanguageModel;

  /** Build harness tools. The harness package owns the tool list; the
   *  machine doesn't know which tools exist, just hands the result to
   *  the harness. */
  buildTools(agent: AgentConfig, sandbox: SandboxExecutor): Promise<unknown>;

  /** Build the harness instance + context for one turn. The shell does
   *  this so the machine doesn't need a hard dep on
   *  `@open-managed-agents/agent`. The machine just calls run().
   *
   *  Async because shells often need to warm up state (e.g. read the
   *  event log into the harness's history cache) before harness.run
   *  reads from it. */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
  }): Promise<unknown>;

  /** Publish a synthetic event to the hub (e.g. session.error,
   *  session.status_idle on recovery). The shell wires this with the
   *  in-process or DO-level hub. */
  publish(event: SessionEvent): void;

  /** Logger. Defaults to console. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class SessionStateMachine {
  private activeTurnId: TurnId | null = null;
  private logger: NonNullable<SessionMachineDeps["logger"]>;

  constructor(private deps: SessionMachineDeps) {
    this.logger = deps.logger ?? {
      warn: (msg, ctx) => console.warn(`[session ${deps.sessionId}] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[session ${deps.sessionId}] ${msg}`),
    };
  }

  /** Currently-running turn id, or null if idle. Used by per-platform
   *  shells to decide whether to keep the alarm armed (CF) or skip a
   *  recovery scan that would race the active turn. */
  hasInflightTurn(): boolean {
    return this.activeTurnId !== null;
  }

  /**
   * Drive one harness turn. beginTurn → harness.run → endTurn.
   *
   * Throws on any harness failure; caller (the shell's HTTP route or
   * registry) decides whether to mark session error or just let the
   * status flip back to idle for the user to retry.
   */
  async runHarnessTurn(
    agentId: string,
    userMessage: UserMessageEvent,
  ): Promise<void> {
    const agent = await this.deps.loadAgent(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);

    const turnId = nanoid();
    this.activeTurnId = turnId;
    await this.deps.adapter.beginTurn(this.deps.sessionId, turnId);
    this.deps.adapter.hintTurnInFlight?.(this.deps.sessionId, turnId);

    try {
      // Memory store mounts: optional adapter step, runs once per turn
      // so a session newly bound to a store picks it up on the next
      // user.message without restarting.
      if (this.deps.mountMemoryStores) {
        await this.deps.mountMemoryStores({ sandbox: this.deps.sandbox });
      }

      const tools = await this.deps.buildTools(agent, this.deps.sandbox);
      const model = this.deps.buildModel(agent);
      const ctx = await this.deps.buildHarnessContext({
        agent,
        userMessage,
        sandbox: this.deps.sandbox,
        tools,
        model,
      });

      const harness = this.deps.buildHarness();
      await harness.run(ctx);
    } finally {
      this.activeTurnId = null;
      await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "idle");
    }
  }

  /**
   * Reconcile orphan turns. Reads sessions WHERE status='running',
   * filters out our own active turn, and runs recoverInterruptedState
   * for each. Recovery injects placeholder events into the event log so
   * the next user.message sees a clean tool-use bijection.
   *
   * Idempotent + safe to call repeatedly.
   */
  async onWake(): Promise<void> {
    const orphans = await this.deps.adapter.listOrphanTurns(this.deps.sessionId);
    for (const o of orphans) {
      if (o.turn_id === this.activeTurnId) continue; // we own it
      await this.recoverOrphan(o);
    }
  }

  /**
   * Externally-driven destroy. The shell calls this on graceful
   * shutdown of a session (DELETE /v1/sessions/:id). Kills any
   * in-flight sandbox + flips status to 'destroyed'.
   */
  async destroy(): Promise<void> {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    try {
      if (this.deps.sandbox.destroy) await this.deps.sandbox.destroy();
    } catch (err) {
      this.logger.warn(`sandbox destroy failed: ${(err as Error).message}`);
    }
    if (turnId) {
      await this.deps.adapter.endTurn(this.deps.sessionId, turnId, "destroyed");
    } else {
      // No active turn — directly mark the row destroyed.
      await this.deps.adapter.endTurn(this.deps.sessionId, "", "destroyed");
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async recoverOrphan(o: OrphanTurn): Promise<void> {
    this.logger.warn(
      `recovering orphan turn ${o.turn_id} (started ${
        Date.now() - o.turn_started_at
      }ms ago)`,
    );

    // recoverInterruptedState wants an EventLogRepo with sync getEvents
    // — same contract the CF DO uses. The adapter's eventLog satisfies
    // it on both platforms (SqlEventLog implements the async surface,
    // and we serve the sync requirement via the same in-memory cache
    // the harness already uses... but here on cold start we don't have
    // a cache). The shell's `publish` is for warning broadcast; the
    // recovery-injected events themselves go through eventLog.append.

    // Read the event log into a synchronous snapshot (recovery is pure;
    // it just needs the array). We cast the SQL-backed log to the sync
    // shape with a wrapper.
    const allEvents = await (
      this.deps.adapter.eventLog as unknown as {
        getEventsAsync(): Promise<SessionEvent[]>;
      }
    ).getEventsAsync();

    const syncLog: Pick<typeof this.deps.adapter.eventLog, "append" | "getEvents"> = {
      append: (event: SessionEvent) => this.deps.adapter.eventLog.append(event),
      getEvents: () => allEvents,
    };

    const report = await recoverInterruptedState(
      this.deps.adapter.streams,
      syncLog,
    );

    // Broadcast warnings so live SSE subscribers see what happened.
    for (const w of report.warnings) {
      this.deps.publish({
        type: "session.warning",
        source: w.source,
        message: w.message,
        ...w.details,
      } as unknown as SessionEvent);
    }

    // Mark the orphaned turn done so subsequent listOrphanTurns calls
    // don't re-trigger recovery.
    await this.deps.adapter.endTurn(this.deps.sessionId, o.turn_id, "idle");
  }
}
