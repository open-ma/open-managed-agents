// SessionRegistry — Node thin shell around the unified SessionStateMachine.
//
// One SessionRegistry per process; one SessionStateMachine per active
// session, lazily created on first request. The shell's job is:
//
//   1. Hold the per-process deps (sql, hub, services, env-derived
//      config) in its closure.
//   2. Lazily build a SessionStateMachine on first access. The machine
//      itself owns the per-session sandbox + adapter.
//   3. Run a one-shot bootstrap() at process start to wake any session
//      whose row was left status='running' by a prior process (orphan
//      recovery via the unified machine.onWake path).
//
// Mirrors what apps/agent's SessionDO will become in Phase 3 (a thin
// shell around the same machine, with `alarm()` instead of bootstrap()
// as the orphan-detection trigger).

import { join } from "node:path";
import {
  RuntimeAdapterImpl,
  SessionStateMachine,
} from "@open-managed-agents/session-runtime";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlStreamRepo, type SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import type { LanguageModel } from "ai";
import type { InProcessEventStreamHub } from "./lib/event-stream-hub.js";

export interface SessionRegistryDeps {
  sql: SqlClient;
  hub: InProcessEventStreamHub;
  agentsService: AgentService;
  memoryService: MemoryStoreService;

  /** Build the per-session event log. Mirrors main-node's existing
   *  newEventLog(sid) — keeps the stamp closure local to the shell. */
  newEventLog(sessionId: string): SqlEventLog;

  /** Build the per-session sandbox. The shell knows how to assemble a
   *  LocalSubprocess / E2B / Daytona / etc., the machine doesn't. */
  buildSandbox(sessionId: string, workdir: string): Promise<SandboxExecutor>;

  /** Mount session-bound memory stores into the sandbox. */
  buildMemoryMounter(
    sessionId: string,
    tenantId: string,
  ): (opts: { sandbox: SandboxExecutor }) => Promise<void>;

  /** Build the LanguageModel for the agent. Reads env, applies custom
   *  headers, picks the right provider. */
  buildModel(agent: AgentConfig): LanguageModel;

  /** Build harness tools. Returns the tools dict the harness expects. */
  buildTools(
    agent: AgentConfig,
    sandbox: SandboxExecutor,
  ): Promise<unknown>;

  /** Build harness instance + context. Each is platform-neutral so the
   *  machine just calls .run(ctx). */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
    sessionId: string;
    eventLog: SqlEventLog;
  }): Promise<unknown>;

  /** Sandbox workdir root, e.g. /app/data/sandboxes. Per-session dirs
   *  are joined under it. */
  sandboxWorkdirRoot: string;
}

interface SessionEntry {
  machine: SessionStateMachine;
  sandbox: SandboxExecutor;
  eventLog: SqlEventLog;
}

export class SessionRegistry {
  private map = new Map<string, Promise<SessionEntry>>();

  constructor(private deps: SessionRegistryDeps) {}

  /**
   * Get-or-create the SessionStateMachine for a session. Lazy: the
   * sandbox + adapter aren't built until first access. Cached: the same
   * machine is reused across HTTP requests (so chokidar watcher /
   * recovery / repeated user.messages all hit the same in-memory state).
   */
  async getOrCreate(sessionId: string, tenantId: string): Promise<SessionEntry> {
    let p = this.map.get(sessionId);
    if (!p) {
      p = this.build(sessionId, tenantId);
      this.map.set(sessionId, p);
    }
    return p;
  }

  /**
   * Process-startup orphan reconciliation. Reads sessions WHERE
   * status='running' and calls onWake() on each. Survivors of a prior
   * crash get their event log cleaned up (placeholder agent.message +
   * tool_result events injected) and the row flips back to 'idle'.
   *
   * No automatic re-execution of the interrupted turn — the user gets
   * a clean state and can retry by sending a new user.message. Mirrors
   * what apps/main-node did inline before this refactor.
   */
  async bootstrap(): Promise<void> {
    const r = await this.deps.sql
      .prepare(
        `SELECT id, tenant_id FROM sessions WHERE status='running' AND turn_id IS NOT NULL`,
      )
      .all<{ id: string; tenant_id: string }>();
    const rows = r.results ?? [];
    if (rows.length === 0) return;
    console.log(`[session-registry] bootstrap: recovering ${rows.length} interrupted session(s)`);
    for (const row of rows) {
      const entry = await this.getOrCreate(row.id, row.tenant_id);
      try {
        await entry.machine.onWake();
      } catch (err) {
        console.error(
          `[session-registry] bootstrap onWake(${row.id}) failed`,
          err,
        );
      }
    }
  }

  /**
   * Tear down all in-process sessions on shutdown. Best-effort; the
   * sessions row stays as-is (status='idle' for normal exits, status=
   * 'running' for kill -9, which the next bootstrap will handle).
   */
  async shutdown(): Promise<void> {
    for (const p of this.map.values()) {
      try {
        const entry = await p;
        if (entry.sandbox.destroy) await entry.sandbox.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.map.clear();
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async build(
    sessionId: string,
    tenantId: string,
  ): Promise<SessionEntry> {
    const sandboxWorkdir = join(this.deps.sandboxWorkdirRoot, sessionId);
    const sandbox = await this.deps.buildSandbox(sessionId, sandboxWorkdir);

    // Wire outbound credential injection. setOutboundContext is optional on
    // the SandboxExecutor port (Daytona doesn't intercept TLS, e.g.).
    await sandbox.setOutboundContext?.({ tenantId, sessionId });

    const eventLog = this.deps.newEventLog(sessionId);
    const streams = new SqlStreamRepo(this.deps.sql, sessionId);

    const adapter = new RuntimeAdapterImpl({
      sql: this.deps.sql,
      eventLog,
      streams,
      sandbox,
      // Node has no eviction — leave hintTurnInFlight unset.
    });

    const memoryMounter = this.deps.buildMemoryMounter(sessionId, tenantId);

    const machine = new SessionStateMachine({
      sessionId,
      tenantId,
      adapter,
      sandbox,
      loadAgent: async (agentId) => {
        const row = await this.deps.agentsService.get({ tenantId, agentId });
        return row ?? null;
      },
      mountMemoryStores: memoryMounter,
      buildModel: (agent) => this.deps.buildModel(agent),
      buildTools: (agent, sb) => this.deps.buildTools(agent, sb),
      buildHarness: () => this.deps.buildHarness(),
      buildHarnessContext: (input) =>
        this.deps.buildHarnessContext({
          ...input,
          sessionId,
          eventLog,
        }),
      publish: (event: SessionEvent) => this.deps.hub.publish(sessionId, event),
    });

    return { machine, sandbox, eventLog };
  }
}
