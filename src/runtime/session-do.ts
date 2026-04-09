import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type {
  AgentConfig,
  EnvironmentConfig,
  SessionEvent,
  UserMessageEvent,
  UserInterruptEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserDefineOutcomeEvent,
  OutcomeEvaluationEvent,
  AgentMessageEvent,
} from "../types";
import type { HarnessContext, HarnessInterface, HistoryStore, SandboxExecutor } from "../harness/interface";
import { resolveHarness } from "../harness/registry";
import { resolveModel } from "../harness/provider";
import { evaluateOutcome } from "../harness/outcome-evaluator";
import { SqliteHistory, InMemoryHistory } from "./history";
import { createSandbox, CloudflareSandbox } from "./sandbox";

interface SessionInitParams {
  agent_id: string;
  environment_id: string;
  title: string;
  session_id?: string;
}

/**
 * SessionDO is the "meta-harness" — it owns the event log, WebSocket
 * connections, and runtime primitives. It resolves a concrete harness
 * via the registry and delegates message processing to it, without
 * knowing anything about the harness implementation.
 *
 * Sandbox lifecycle: one sandbox per session, created on first event,
 * reused across turns, destroyed on session delete/terminate.
 */
export class SessionDO extends DurableObject<Env> {
  private initialized = false;
  private sandbox: SandboxExecutor | null = null;
  private sandboxWarmedUp = false;
  private threads = new Map<string, { agentId: string; agentConfig: AgentConfig }>();

  private ensureSchema() {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        ts TEXT DEFAULT (datetime('now'))
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM session_meta WHERE key = ?", key)
      .toArray();
    return row.length > 0 ? row[0].value : null;
  }

  private setMeta(key: string, value: string) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO session_meta (key, value) VALUES (?, ?)",
      key,
      value
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    // PUT /init — initialize session
    if (request.method === "PUT" && url.pathname === "/init") {
      const params = (await request.json()) as SessionInitParams;
      this.setMeta("agent_id", params.agent_id);
      this.setMeta("environment_id", params.environment_id);
      this.setMeta("title", params.title);
      if (params.session_id) this.setMeta("session_id", params.session_id);
      this.setMeta("status", "idle");

      // Pre-warm sandbox in background (container start + package install)
      // Errors are swallowed — warmup is best-effort
      this.ctx.waitUntil(this.warmUpSandbox());

      return new Response("ok");
    }

    // DELETE /destroy — tear down sandbox and clean up
    if (request.method === "DELETE" && url.pathname === "/destroy") {
      this.sandbox = null;
      this.sandboxWarmedUp = false;
      this.setMeta("status", "terminated");

      const terminatedEvent: SessionEvent = {
        type: "session.status_terminated",
        reason: "session_deleted",
      };
      const history = new SqliteHistory(this.ctx.storage.sql);
      history.append(terminatedEvent);
      this.broadcastEvent(terminatedEvent);

      return new Response("ok");
    }

    // POST /event — receive user event, kick off harness
    if (request.method === "POST" && url.pathname === "/event") {
      const body = (await request.json()) as SessionEvent;
      const history = new SqliteHistory(this.ctx.storage.sql);

      if (body.type === "user.message") {
        history.append(body);
        this.setMeta("status", "processing");
        this.ctx.waitUntil(this.processUserMessage(body));
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.interrupt") {
        this.setMeta("status", "idle");
        const idleEvent: SessionEvent = { type: "session.status_idle" };
        history.append(body as UserInterruptEvent);
        history.append(idleEvent);
        this.broadcastEvent(idleEvent);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.tool_confirmation") {
        history.append(body as UserToolConfirmationEvent);
        this.broadcastEvent(body as UserToolConfirmationEvent);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.custom_tool_result") {
        history.append(body as UserCustomToolResultEvent);
        this.broadcastEvent(body as UserCustomToolResultEvent);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.define_outcome") {
        const e = body as UserDefineOutcomeEvent;
        this.setMeta("outcome", JSON.stringify(e.outcome));
        this.setMeta("outcome_iteration", "1");
        history.append(e);
        this.broadcastEvent(e);
        return new Response(null, { status: 202 });
      }

      return new Response("Unknown event type", { status: 400 });
    }

    // GET /ws — WebSocket upgrade
    if (request.method === "GET" && url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);

      // Replay existing events to new connection
      const history = new SqliteHistory(this.ctx.storage.sql);
      const events = history.getEvents();
      for (const event of events) {
        pair[1].send(JSON.stringify(event));
      }

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // GET /status
    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: this.getMeta("status") || "idle",
        agent_id: this.getMeta("agent_id"),
        environment_id: this.getMeta("environment_id"),
        usage: {
          input_tokens: parseInt(this.getMeta("input_tokens") || "0", 10),
          output_tokens: parseInt(this.getMeta("output_tokens") || "0", 10),
        },
      });
    }

    // GET /events — paginated event list
    if (request.method === "GET" && url.pathname === "/events") {
      const limitParam = url.searchParams.get("limit");
      let limit = limitParam ? parseInt(limitParam, 10) : 100;
      if (isNaN(limit) || limit < 1) limit = 100;
      if (limit > 1000) limit = 1000;

      const order = url.searchParams.get("order") === "desc" ? "DESC" : "ASC";
      const afterSeqParam = url.searchParams.get("after_seq");
      const afterSeq = afterSeqParam ? parseInt(afterSeqParam, 10) : 0;

      // Fetch limit + 1 to determine has_more
      const query = `SELECT seq, type, data, ts FROM events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`;
      const rows = this.ctx.storage.sql
        .exec(query, afterSeq, limit + 1)
        .toArray();

      const hasMore = rows.length > limit;
      const resultRows = hasMore ? rows.slice(0, limit) : rows;

      const events = resultRows.map((row) => ({
        seq: row.seq,
        type: row.type,
        data: JSON.parse(row.data as string),
        ts: row.ts,
      }));

      const lastSeq = resultRows.length > 0 ? resultRows[resultRows.length - 1].seq : null;
      return Response.json({
        data: events,
        has_more: hasMore,
        next_page: hasMore && lastSeq !== null ? `seq_${lastSeq}` : null,
      });
    }

    // POST /usage — increment token usage counters
    if (request.method === "POST" && url.pathname === "/usage") {
      const body = (await request.json()) as {
        input_tokens: number;
        output_tokens: number;
      };

      const currentInput = parseInt(this.getMeta("input_tokens") || "0", 10);
      const currentOutput = parseInt(this.getMeta("output_tokens") || "0", 10);

      this.setMeta("input_tokens", String(currentInput + (body.input_tokens || 0)));
      this.setMeta("output_tokens", String(currentOutput + (body.output_tokens || 0)));

      return Response.json({
        input_tokens: currentInput + (body.input_tokens || 0),
        output_tokens: currentOutput + (body.output_tokens || 0),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // WebSocket Hibernation API handlers
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // Client-to-DO messages not used in Phase 1
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ) {
    ws.close();
  }

  /**
   * Get or create the session's sandbox. Singleton per session — reused
   * across turns so files persist within the session lifetime.
   */
  private getOrCreateSandbox(): SandboxExecutor {
    if (!this.sandbox) {
      const sessionId = this.ctx.id.toString();
      this.sandbox = createSandbox(this.env, sessionId);
    }
    return this.sandbox;
  }

  /**
   * Pre-warm the sandbox: run a no-op command to trigger container startup,
   * then install environment packages if configured.
   */
  private async warmUpSandbox(): Promise<void> {
    if (this.sandboxWarmedUp) return;
    this.sandboxWarmedUp = true;

    try {
      const sandbox = this.getOrCreateSandbox();

      // Trigger container startup with a simple command
      await sandbox.exec("true");

      // Mount R2-backed /workspace for persistent file storage
      if (sandbox instanceof CloudflareSandbox) {
        await sandbox.mountWorkspace();
      }

      // Install environment packages if configured
      const envId = this.getMeta("environment_id");
      if (envId) {
        const envJson = await this.env.CONFIG_KV.get(`env:${envId}`);
        if (envJson) {
          const envConfig = JSON.parse(envJson) as EnvironmentConfig;
          const pkgs = envConfig.config?.packages;
          if (pkgs) {
            const cmds: string[] = [];
            if (pkgs.apt?.length) cmds.push(`apt-get update -qq && apt-get install -y -qq ${pkgs.apt.join(" ")}`);
            if (pkgs.pip?.length) cmds.push(`pip install -q ${pkgs.pip.join(" ")}`);
            if (pkgs.npm?.length) cmds.push(`npm install -g ${pkgs.npm.join(" ")}`);
            if (pkgs.cargo?.length) cmds.push(`cargo install ${pkgs.cargo.join(" ")}`);
            if (pkgs.gem?.length) cmds.push(`gem install ${pkgs.gem.join(" ")}`);
            if (pkgs.go?.length) cmds.push(`go install ${pkgs.go.join(" ")}`);
            if (cmds.length > 0) {
              await sandbox.exec(cmds.join(" && "), 120000);
            }
          }
        }
      }

      // Mount file resources into sandbox
      const sessionId = this.getMeta("session_id");
      if (sessionId) {
        const resourceList = await this.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
        for (const k of resourceList.keys) {
          const data = await this.env.CONFIG_KV.get(k.name);
          if (!data) continue;
          const res = JSON.parse(data);
          if (res.type === "file" && res.file_id) {
            const fileContent = await this.env.CONFIG_KV.get(`filecontent:${res.file_id}`);
            if (fileContent) {
              const mountPath = res.mount_path || `/workspace/${res.file_id}`;
              await sandbox.writeFile(mountPath, fileContent);
            }
          }
        }
      }
    } catch {
      // Warmup failed — sandbox may not be available (e.g., test environment).
      // Tools will still try and return errors gracefully.
    }
  }

  private broadcastEvent(event: SessionEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Connection already closed
      }
    }
  }

  /**
   * Run a sub-agent within the same session. Creates an isolated thread
   * with its own message history but shares the same sandbox. Events are
   * tagged with thread_id and written to the parent event log.
   */
  private async runSubAgent(
    agentId: string,
    message: string,
    parentHistory: HistoryStore,
    sandbox: SandboxExecutor,
  ): Promise<string> {
    // Generate a unique thread ID
    const threadId = `thread_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Fetch sub-agent config from KV
    const agentJson = await this.env.CONFIG_KV.get(`agent:${agentId}`);
    if (!agentJson) {
      return `Sub-agent error: agent "${agentId}" not found`;
    }
    const subAgent = JSON.parse(agentJson) as AgentConfig;

    // Store thread
    this.threads.set(threadId, { agentId, agentConfig: subAgent });

    // Emit thread_created
    const threadCreatedEvent: SessionEvent = {
      type: "session.thread_created",
      thread_id: threadId,
      agent_id: agentId,
      agent_name: subAgent.name,
    };
    parentHistory.append(threadCreatedEvent);
    this.broadcastEvent(threadCreatedEvent);

    // Create sub-agent's isolated history
    const subHistory = new InMemoryHistory();
    const userMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: message }],
    };
    subHistory.append(userMsg);

    // Resolve harness for the sub-agent
    let harness: HarnessInterface;
    try {
      harness = resolveHarness(subAgent.harness);
    } catch {
      harness = resolveHarness("default");
    }

    // Build sub-agent context: own history, shared sandbox, parent event log
    const subCtx: HarnessContext = {
      agent: subAgent,
      userMessage: userMsg,
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        // Sub-agents can also delegate (nested threads)
        delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
          return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox);
        },
      },
      runtime: {
        history: subHistory,
        sandbox,
        broadcast: (event) => {
          // Write to sub-agent's own history
          subHistory.append(event);
          // Tag and write to parent log + broadcast
          const taggedEvent = { ...event, thread_id: threadId };
          parentHistory.append(taggedEvent);
          this.broadcastEvent(taggedEvent);
        },
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          const currentInput = parseInt(this.getMeta("input_tokens") || "0", 10);
          const currentOutput = parseInt(this.getMeta("output_tokens") || "0", 10);
          this.setMeta("input_tokens", String(currentInput + input_tokens));
          this.setMeta("output_tokens", String(currentOutput + output_tokens));
        },
      },
    };

    // Run the sub-agent harness
    await harness.run(subCtx);

    // Collect sub-agent response text from its history
    const subEvents = subHistory.getEvents();
    const responseText = subEvents
      .filter((e: SessionEvent) => e.type === "agent.message")
      .map((e: SessionEvent) => {
        const msg = e as AgentMessageEvent;
        return msg.content?.map((b) => b.text).join("") || "";
      })
      .join("\n");

    // Emit thread_idle
    const threadIdleEvent: SessionEvent = { type: "session.thread_idle", thread_id: threadId };
    parentHistory.append(threadIdleEvent);
    this.broadcastEvent(threadIdleEvent);

    return responseText || "(sub-agent produced no text output)";
  }

  private async processUserMessage(userMessage: UserMessageEvent) {
    const agentId = this.getMeta("agent_id");
    if (!agentId) return;

    const agentJson = await this.env.CONFIG_KV.get(`agent:${agentId}`);
    if (!agentJson) {
      this.broadcastEvent({ type: "session.error", error: "Agent not found" });
      this.setMeta("status", "idle");
      return;
    }

    const agent = JSON.parse(agentJson) as AgentConfig;
    const history = new SqliteHistory(this.ctx.storage.sql);

    // Reuse session-level sandbox (singleton) — files persist across turns
    const sandbox = this.getOrCreateSandbox();

    // Pre-warm sandbox on first use (container cold start + package install)
    await this.warmUpSandbox();

    // Fetch environment config for networking restrictions
    const envId = this.getMeta("environment_id");
    let environmentConfig: { networking?: { type: string; allowed_hosts?: string[] } } | undefined;
    if (envId) {
      const envJson = await this.env.CONFIG_KV.get(`env:${envId}`);
      if (envJson) {
        const envCfg = JSON.parse(envJson) as EnvironmentConfig;
        environmentConfig = envCfg.config;
      }
    }

    // Fetch memory store IDs from session resources
    const sessionId = this.getMeta("session_id");
    const memoryStoreIds: string[] = [];
    if (sessionId) {
      const resourceList = await this.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
      for (const k of resourceList.keys) {
        const data = await this.env.CONFIG_KV.get(k.name);
        if (data) {
          const res = JSON.parse(data);
          if (res.type === "memory_store" && res.memory_store_id) {
            memoryStoreIds.push(res.memory_store_id);
          }
        }
      }
    }

    // Resolve harness via registry — SessionDO never imports a concrete harness
    let harness: HarnessInterface;
    try {
      harness = resolveHarness(agent.harness);
    } catch {
      harness = resolveHarness("default");
    }

    const ctx: HarnessContext = {
      agent,
      userMessage,
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        CONFIG_KV: this.env.CONFIG_KV,
        memoryStoreIds,
        environmentConfig,
        delegateToAgent: async (agentId: string, message: string) => {
          return this.runSubAgent(agentId, message, history, sandbox);
        },
      },
      runtime: {
        history,
        sandbox,
        broadcast: (event) => {
          history.append(event);
          this.broadcastEvent(event);
        },
        reportUsage: async (input_tokens: number, output_tokens: number) => {
          const currentInput = parseInt(this.getMeta("input_tokens") || "0", 10);
          const currentOutput = parseInt(this.getMeta("output_tokens") || "0", 10);
          this.setMeta("input_tokens", String(currentInput + input_tokens));
          this.setMeta("output_tokens", String(currentOutput + output_tokens));
        },
        pendingConfirmations: [],
      },
    };

    try {
      // Broadcast running status
      const runningEvent: SessionEvent = { type: "session.status_running" };
      history.append(runningEvent);
      this.broadcastEvent(runningEvent);

      await harness.run(ctx);

      // Outcome self-evaluation loop
      const outcomeJson = this.getMeta("outcome");
      if (outcomeJson) {
        const outcome = JSON.parse(outcomeJson);
        const iteration = parseInt(this.getMeta("outcome_iteration") || "1", 10);
        const maxIterations = Math.min(outcome.max_iterations || 3, 20);

        // Collect agent output from recent events
        const recentEvents = history.getEvents();
        const agentOutput = recentEvents
          .filter((e: SessionEvent) => e.type === "agent.message")
          .map((e: SessionEvent) => {
            const msg = e as import("../types").AgentMessageEvent;
            return msg.content?.map((b) => b.text).join("") || "";
          })
          .join("\n");

        // Evaluate using the agent's model
        const model = resolveModel(agent.model, ctx.env.ANTHROPIC_API_KEY, ctx.env.ANTHROPIC_BASE_URL);

        // Span: outcome evaluation start
        this.broadcastEvent({ type: "span.outcome_evaluation_start", iteration });

        // Span: ongoing heartbeat before evaluation completes
        const ongoingEvent: SessionEvent = {
          type: "span.outcome_evaluation_ongoing",
          iteration,
        };
        history.append(ongoingEvent);
        this.broadcastEvent(ongoingEvent);

        const evalResult = await evaluateOutcome(model, outcome, agentOutput);

        // Span: outcome evaluation end

        if (evalResult.result === "satisfied") {
          const evalEvent: OutcomeEvaluationEvent = {
            type: "outcome.evaluation_end",
            result: "satisfied",
            iteration,
            feedback: evalResult.feedback,
          };
          history.append(evalEvent);
          this.broadcastEvent(evalEvent);
          this.setMeta("outcome", "");
        } else if (iteration >= maxIterations) {
          const evalEvent: OutcomeEvaluationEvent = {
            type: "outcome.evaluation_end",
            result: "max_iterations_reached",
            iteration,
          };
          history.append(evalEvent);
          this.broadcastEvent(evalEvent);
          this.setMeta("outcome", "");
        } else {
          // Needs revision — inject feedback and re-run
          const evalEvent: OutcomeEvaluationEvent = {
            type: "outcome.evaluation_end",
            result: "needs_revision",
            iteration,
            feedback: evalResult.feedback,
          };
          history.append(evalEvent);
          this.broadcastEvent(evalEvent);
          this.setMeta("outcome_iteration", String(iteration + 1));

          const feedbackMsg: UserMessageEvent = {
            type: "user.message",
            content: [{
              type: "text",
              text: `[Outcome Evaluation - Iteration ${iteration}] Needs revision:\n${evalResult.feedback}\n\nPlease address the feedback and try again.`,
            }],
          };
          history.append(feedbackMsg);
          this.broadcastEvent(feedbackMsg);
          await harness.run({ ...ctx, userMessage: feedbackMsg });
        }
      }

      // Determine stop reason based on pending tool confirmations
      const pendingConfirmations = ctx.runtime.pendingConfirmations || [];
      const stopReason = pendingConfirmations.length > 0
        ? { type: "tool_confirmation_required" as const, event_ids: pendingConfirmations }
        : { type: "user.message_required" as const };

      const idleEvent: SessionEvent = {
        type: "session.status_idle",
        stop_reason: stopReason,
      };
      history.append(idleEvent);
      this.broadcastEvent(idleEvent);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const TRANSIENT_PATTERNS = ["timeout", "network", "ECONNREFUSED", "fetch failed"];
      const isTransient = TRANSIENT_PATTERNS.some((p) => errorMessage.toLowerCase().includes(p.toLowerCase()));

      if (isTransient) {
        const rescheduledEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: errorMessage,
        };
        history.append(rescheduledEvent);
        this.broadcastEvent(rescheduledEvent);
      } else {
        const errorEvent: SessionEvent = {
          type: "session.error",
          error: errorMessage,
        };
        history.append(errorEvent);
        this.broadcastEvent(errorEvent);
      }

      // Harness crashed — but session is recoverable.
      // The event log has everything up to the crash point.
      // The sandbox is still alive (container persists independently).
      // Client can send a new user.message to retry.
      // This is the "brain is cattle" principle from Anthropic's design:
      // the harness is stateless, it can crash and restart from the event log.
    } finally {
      this.setMeta("status", "idle");
    }
  }
}
