import { DurableObject } from "cloudflare:workers";
import type { Env } from "@open-managed-agents/shared";
import type {
  AgentConfig,
  EnvironmentConfig,
  CredentialConfig,
  SessionEvent,
  UserMessageEvent,
  UserInterruptEvent,
  UserToolConfirmationEvent,
  UserCustomToolResultEvent,
  UserDefineOutcomeEvent,
  OutcomeEvaluationEvent,
  AgentMessageEvent,
  AgentToolUseEvent,
} from "@open-managed-agents/shared";
import type { HarnessContext, HarnessInterface, HistoryStore, SandboxExecutor, ProcessHandle } from "../harness/interface";
import { resolveHarness } from "../harness/registry";
import { resolveModel } from "../harness/provider";
import { evaluateOutcome } from "../harness/outcome-evaluator";
import { buildTools, buildMemoryTools } from "../harness/tools";
import { resolveSkills, resolveCustomSkills, getSkillFiles } from "../harness/skills";
import { SqliteHistory, InMemoryHistory } from "./history";
import { createSandbox, CloudflareSandbox } from "./sandbox";
import { mountResources } from "./resource-mounter";

interface SessionInitParams {
  agent_id: string;
  environment_id: string;
  title: string;
  session_id?: string;
}

/**
 * Pending tool call data stored in session metadata so that
 * tool confirmation/custom tool result events can resume execution.
 */
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
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
  private sandboxWarmupPromise: Promise<void> | null = null;
  private threads = new Map<string, { agentId: string; agentConfig: AgentConfig }>();
  private currentAbortController: AbortController | null = null;
  private backgroundTaskPollers = new Map<string, ReturnType<typeof setInterval>>();

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

  /**
   * Alarm handler: runs the agent loop with full DO lifetime.
   * Alarm handlers get 15 minutes wall-clock time (vs waitUntil's 30s).
   * This is where the actual LLM calls + tool execution happens.
   */
  async alarm(): Promise<void> {
    const pendingJson = this.getMeta("pending_user_message");
    if (!pendingJson) return;

    // Clear immediately to prevent re-processing on alarm retry
    this.setMeta("pending_user_message", "");

    try {
      const userMessage = JSON.parse(pendingJson) as UserMessageEvent;
      await this.processUserMessage(userMessage);
    } catch (err) {
      // If alarm processing fails, ensure we don't stay stuck in "running"
      const errorMsg = err instanceof Error ? err.message : String(err);
      const history = new SqliteHistory(this.ctx.storage.sql);
      const errorEvent: SessionEvent = { type: "session.error", error: errorMsg };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);
      this.setMeta("status", "idle");
    }
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
      // Abort any running harness
      if (this.currentAbortController) {
        this.currentAbortController.abort();
        this.currentAbortController = null;
      }
      this.sandbox = null;
      this.sandboxWarmupPromise = null;
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
        this.setMeta("status", "running");
        // Store the message for alarm-based processing.
        // Using alarm() ensures the agent loop runs with full DO lifetime
        // (not limited by waitUntil's 30s after client disconnect).
        this.setMeta("pending_user_message", JSON.stringify(body));
        await this.ctx.storage.setAlarm(Date.now() + 1);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.interrupt") {
        // Abort the running harness
        if (this.currentAbortController) {
          this.currentAbortController.abort();
          this.currentAbortController = null;
        }
        this.setMeta("status", "idle");
        const idleEvent: SessionEvent = { type: "session.status_idle" };
        history.append(body as UserInterruptEvent);
        history.append(idleEvent);
        this.broadcastEvent(idleEvent);
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.tool_confirmation") {
        const confirmation = body as UserToolConfirmationEvent;
        history.append(confirmation);
        this.broadcastEvent(confirmation);

        // Resume execution: execute the confirmed tool or inject denial, then re-run harness
        this.setMeta("status", "running");
        this.ctx.waitUntil(this.handleToolConfirmation(confirmation, history));
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.custom_tool_result") {
        const customResult = body as UserCustomToolResultEvent;
        history.append(customResult);
        this.broadcastEvent(customResult);

        // Convert custom tool result to agent.tool_result and re-run harness
        const toolResultEvent: SessionEvent = {
          type: "agent.tool_result",
          tool_use_id: customResult.custom_tool_use_id,
          content: customResult.content.map(b => b.type === "text" ? b.text : "").join(""),
        };
        history.append(toolResultEvent);
        this.broadcastEvent(toolResultEvent);

        // Re-run harness to continue the conversation
        this.setMeta("status", "running");
        const resumeMsg: UserMessageEvent = {
          type: "user.message",
          content: [{ type: "text", text: "" }], // Empty message — history has the tool result
        };
        this.ctx.waitUntil(this.processUserMessage(resumeMsg, 0, true));
        return new Response(null, { status: 202 });
      }

      if (body.type === "user.define_outcome") {
        const e = body as UserDefineOutcomeEvent;
        this.setMeta("outcome", JSON.stringify({ description: e.description, rubric: e.rubric, max_iterations: e.max_iterations }));
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
   * Returns a promise that resolves when warmup is complete.
   * Multiple callers share the same promise — warmup runs exactly once.
   */
  private warmUpSandbox(): Promise<void> {
    if (!this.sandboxWarmupPromise) {
      this.sandboxWarmupPromise = this.doWarmUpSandbox().catch((err) => {
        // Clear cached promise on failure so next call retries
        this.sandboxWarmupPromise = null;
        throw err;
      });
    }
    return this.sandboxWarmupPromise;
  }

  private async doWarmUpSandbox(): Promise<void> {

    try {
      const sandbox = this.getOrCreateSandbox();

      // Trigger container startup with retries — local dev containers can take
      // 30-60s to start. SDK returns 503 while container port isn't listening.
      // See: https://github.com/cloudflare/containers/issues/155
      let ready = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await sandbox.exec("true");
          ready = true;
          break;
        } catch {
          // Container not ready yet — exponential backoff: 3s, 4.5s, 6.75s, ...
          const delay = 3000 * Math.pow(1.5, attempt);
          await new Promise(r => setTimeout(r, Math.min(delay, 15000)));
        }
      }
      if (!ready) {
        throw new Error("Sandbox container failed to start after 10 attempts");
      }

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

      // Mount all session resources (files, git repos, env secrets)
      const sessionId = this.getMeta("session_id");
      if (sessionId) {
        const resourceList = await this.env.CONFIG_KV.list({ prefix: `sesrsc:${sessionId}:` });
        const resources: Array<Record<string, unknown>> = [];
        const secretStore = new Map<string, string>();

        for (const k of resourceList.keys) {
          const data = await this.env.CONFIG_KV.get(k.name);
          if (!data) continue;
          const res = JSON.parse(data);
          resources.push(res);

          // Load write-only secrets from separate KV keys
          if (res.id) {
            const secretData = await this.env.CONFIG_KV.get(`secret:${sessionId}:${res.id}`);
            if (secretData) secretStore.set(res.id, secretData);
          }
        }

        if (resources.length) {
          await mountResources(sandbox, resources, this.env.CONFIG_KV, secretStore);
        }
      }

      // Register command_secret credentials from vaults
      // These inject env vars only for commands matching specific prefixes
      const vaultIds: string[] = JSON.parse(this.getMeta("vault_ids") || "[]");
      if (vaultIds.length && sandbox.registerCommandSecrets) {
        for (const vaultId of vaultIds) {
          const credList = await this.env.CONFIG_KV.list({ prefix: `cred:${vaultId}:` });
          for (const k of credList.keys) {
            const credData = await this.env.CONFIG_KV.get(k.name);
            if (!credData) continue;
            try {
              const cred = JSON.parse(credData) as CredentialConfig;
              if (cred.auth?.type === "command_secret" && cred.auth.command_prefixes?.length && cred.auth.env_var && cred.auth.token) {
                for (const prefix of cred.auth.command_prefixes) {
                  sandbox.registerCommandSecrets(prefix, { [cred.auth.env_var]: cred.auth.token });
                }
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      // Warmup failed — broadcast error event and re-throw to prevent harness from running
      this.broadcastEvent({
        type: "agent.message",
        content: [{ type: "text", text: `Sandbox warmup failed: ${err instanceof Error ? err.message : String(err)}` }],
      });
      throw err;
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
   * Handle tool confirmation: execute the confirmed tool or inject denial,
   * then re-run the harness to continue the conversation.
   */
  private async handleToolConfirmation(
    confirmation: UserToolConfirmationEvent,
    history: HistoryStore
  ): Promise<void> {
    const sandbox = this.getOrCreateSandbox();
    try {
      await this.warmUpSandbox();
    } catch {
      this.broadcastEvent({ type: "session.error", error: "Sandbox not available" });
      return;
    }

    // Retrieve the pending tool call from session metadata
    const pendingJson = this.getMeta("pending_tool_calls");
    const pendingCalls: PendingToolCall[] = pendingJson ? JSON.parse(pendingJson) : [];
    const pending = pendingCalls.find(p => p.toolCallId === confirmation.tool_use_id);

    if (confirmation.result === "allow" && pending) {
      // Execute the tool
      const agentId = this.getMeta("agent_id");
      const agentJson = agentId ? await this.env.CONFIG_KV.get(`agent:${agentId}`) : null;

      if (agentJson) {
        const agent = JSON.parse(agentJson) as AgentConfig;

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

        // Build tools with execute functions intact (not stripped for always_ask)
        const allTools = await buildTools(agent, sandbox, {
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
          TAVILY_API_KEY: this.env.TAVILY_API_KEY,
          environmentConfig,
        });

        // Find the original tool definition (before always_ask stripping)
        // We need to re-build without permission stripping to get the execute function
        const originalTool = allTools[pending.toolName];
        if (originalTool?.execute) {
          try {
            const result = await originalTool.execute(pending.args, {
              toolCallId: pending.toolCallId,
              messages: [],
              abortSignal: undefined,
            });
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: resultStr,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          } catch (e) {
            const toolResultEvent: SessionEvent = {
              type: "agent.tool_result",
              tool_use_id: pending.toolCallId,
              content: `Error: ${e instanceof Error ? e.message : String(e)}`,
            };
            history.append(toolResultEvent);
            this.broadcastEvent(toolResultEvent);
          }
        }
      }
    } else {
      // Denied or not found — inject denial result
      const denyMsg = confirmation.deny_message || "Tool execution was denied by the user.";
      const toolResultEvent: SessionEvent = {
        type: "agent.tool_result",
        tool_use_id: confirmation.tool_use_id,
        content: `Denied: ${denyMsg}`,
      };
      history.append(toolResultEvent);
      this.broadcastEvent(toolResultEvent);
    }

    // Remove the confirmed/denied call from pending
    const remaining = pendingCalls.filter(p => p.toolCallId !== confirmation.tool_use_id);
    if (remaining.length > 0) {
      this.setMeta("pending_tool_calls", JSON.stringify(remaining));
    } else {
      this.setMeta("pending_tool_calls", "");
    }

    // Re-run the harness to continue the conversation
    // Use an empty user message — the history already has the tool result
    const resumeMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: "" }],
    };
    await this.processUserMessage(resumeMsg, 0, true);
  }

  /**
   * Resolve a credential token from vault by credential ID.
   */
  private async resolveCredentialToken(credentialId?: string): Promise<string | null> {
    if (!credentialId) return null;
    const vaultIds: string[] = JSON.parse(this.getMeta("vault_ids") || "[]");
    for (const vaultId of vaultIds) {
      const credData = await this.env.CONFIG_KV.get(`cred:${vaultId}:${credentialId}`);
      if (credData) {
        const cred = JSON.parse(credData);
        return cred.auth?.token || cred.auth?.access_token || null;
      }
    }
    return null;
  }

  /**
   * Register a background task for completion tracking.
   * Starts a setInterval poller that checks process status every 2s.
   * When complete, injects a task_notification event and re-triggers harness.
   * Like CC's shellCommand.result.then() — but poll-based since we can't
   * get exit events from container processes.
   */
  private watchBackgroundTask(
    taskId: string,
    pid: string,
    outputFile: string,
    proc: ProcessHandle | null,
    sandbox: SandboxExecutor,
  ): void {
    // If we have a process handle, poll via getStatus()
    // Otherwise, poll via kill -0 <pid>
    const poller = setInterval(async () => {
      try {
        let done = false;
        let exitCode = 0;

        if (proc) {
          const status = await proc.getStatus();
          done = status === "completed" || status === "error" || status === "killed";
          exitCode = status === "error" ? 1 : status === "killed" ? 137 : 0;
        } else {
          // Fallback: check PID via kill -0
          const check = await sandbox.exec(`kill -0 ${pid} 2>/dev/null && echo running || echo done`, 5000);
          done = check.includes("done");
        }

        if (!done) return;

        // Task completed — stop polling
        clearInterval(poller);
        this.backgroundTaskPollers.delete(taskId);

        // Read output
        let output = "";
        try { output = await sandbox.readFile(outputFile); } catch {}

        // Inject task_notification event
        const history = new SqliteHistory(this.ctx.storage.sql);
        const notifEvent: SessionEvent = {
          type: "user.message",
          content: [{
            type: "text",
            text: `<task_notification>\nBackground task ${taskId} completed (exit code: ${exitCode}).\nOutput file: ${outputFile}\n\n${output.slice(0, 3000)}\n</task_notification>`,
          }],
        };
        history.append(notifEvent);
        this.broadcastEvent(notifEvent);

        // Re-trigger harness if session is idle
        const status = this.getMeta("status");
        if (status === "idle") {
          this.setMeta("status", "running");
          this.setMeta("pending_user_message", JSON.stringify(notifEvent));
          await this.ctx.storage.setAlarm(Date.now() + 100);
        }
      } catch {
        // Poll failed — will retry next interval
      }
    }, 2000);

    this.backgroundTaskPollers.set(taskId, poller);
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

    // Build sub-agent tools and model (platform prepares context for sub-agent too)
    const subTools = await buildTools(subAgent, sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
        return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox);
      },
    });
    const subModelId = typeof subAgent.model === "string" ? subAgent.model : subAgent.model?.id;
    const subModel = resolveModel(subModelId || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_BASE_URL);

    // Build sub-agent context: own history, shared sandbox, parent event log
    const subCtx: HarnessContext = {
      agent: subAgent,
      userMessage: userMsg,
      tools: subTools,
      model: subModel,
      systemPrompt: subAgent.system || "",
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        delegateToAgent: async (nestedAgentId: string, nestedMessage: string) => {
          return this.runSubAgent(nestedAgentId, nestedMessage, parentHistory, sandbox);
        },
      },
      runtime: {
        history: subHistory,
        sandbox,
        broadcast: (event) => {
          subHistory.append(event);
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
        return msg.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
      })
      .join("\n");

    // Emit thread_idle
    const threadIdleEvent: SessionEvent = { type: "session.thread_idle", thread_id: threadId };
    parentHistory.append(threadIdleEvent);
    this.broadcastEvent(threadIdleEvent);

    return responseText || "(sub-agent produced no text output)";
  }

  /**
   * Process a user message: resolve agent, build context, run harness,
   * evaluate outcome, emit status.
   *
   * @param skipAppend — if true, the message is already in history (resume after tool confirmation)
   * @param retryCount — for transient error retries
   */
  private async processUserMessage(
    userMessage: UserMessageEvent,
    retryCount: number = 0,
    skipAppend: boolean = false
  ): Promise<void> {
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
    try {
      await this.warmUpSandbox();
    } catch (err) {
      this.broadcastEvent({
        type: "session.error",
        error: `Sandbox failed to start: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.setMeta("status", "terminated");
      return;
    }

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

    // --- Platform prepares WHAT is available ---

    // Build tools from agent config
    const allTools = await buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
      TAVILY_API_KEY: this.env.TAVILY_API_KEY,
      environmentConfig,
      delegateToAgent: async (agentId: string, message: string) => {
        return this.runSubAgent(agentId, message, history, sandbox);
      },
      watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
        this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
      },
    });

    // Add memory tools if session has memory store resources
    if (memoryStoreIds.length && this.env.CONFIG_KV) {
      const memTools = buildMemoryTools(memoryStoreIds, this.env.CONFIG_KV, this.env.AI, this.env.VECTORIZE);
      Object.assign(allTools, memTools);
    }

    // Resolve model — fall back to ANTHROPIC_MODEL env var if agent doesn't specify one
    const modelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
    const effectiveModelId = modelId || this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const model = resolveModel(effectiveModelId, this.env.ANTHROPIC_API_KEY, this.env.ANTHROPIC_BASE_URL);

    // Build system prompt: base + skill metadata
    let systemPrompt = agent.system || "";
    if (agent.skills?.length) {
      // Built-in (anthropic) skills from the in-memory registry
      const builtinSkills = resolveSkills(agent.skills);
      const additions = builtinSkills.map(s => s.system_prompt_addition).filter(Boolean);

      // Custom skills from KV — lightweight metadata for system prompt
      if (this.env.CONFIG_KV) {
        try {
          const customSkills = await resolveCustomSkills(agent.skills, this.env.CONFIG_KV);
          additions.push(...customSkills.map(s => s.system_prompt_addition).filter(Boolean));
        } catch {
          // Best-effort
        }
      }

      if (additions.length) {
        systemPrompt += "\n\n" + additions.join("\n\n");
      }

      // Mount custom skill files into sandbox (progressive disclosure)
      if (this.env.CONFIG_KV) {
        try {
          const skillFilesResults = await getSkillFiles(agent.skills, this.env.CONFIG_KV);
          for (const sf of skillFilesResults) {
            for (const file of sf.files) {
              try {
                await sandbox.writeFile(
                  `/home/user/.skills/${sf.skillName}/${file.filename}`,
                  file.content,
                );
              } catch {
                // Best-effort: skip individual file write failures
              }
            }
          }
        } catch {
          // Best-effort
        }
      }
    }

    // Create an abort controller for this execution
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    // --- Harness receives a fully-prepared context ---
    const ctx: HarnessContext = {
      agent,
      userMessage,
      tools: allTools,
      model,
      systemPrompt,
      env: {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        ANTHROPIC_BASE_URL: this.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: this.env.ANTHROPIC_MODEL,
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        CONFIG_KV: this.env.CONFIG_KV,
        memoryStoreIds,
        environmentConfig,
        delegateToAgent: async (agentId: string, message: string) => {
          return this.runSubAgent(agentId, message, history, sandbox);
        },
        watchBackgroundTask: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => {
          this.watchBackgroundTask(taskId, pid, outputFile, proc, sandbox);
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
        abortSignal: abortController.signal,
      },
    };

    try {
      // Broadcast running status
      const runningEvent: SessionEvent = { type: "session.status_running" };
      history.append(runningEvent);
      this.broadcastEvent(runningEvent);

      await harness.run(ctx);

      // Store any pending tool calls in session metadata for confirmation flow
      if (ctx.runtime.pendingConfirmations?.length) {
        // Collect pending tool call details from the last harness run events
        const recentEvents = history.getEvents();
        const pendingCalls: PendingToolCall[] = [];
        for (const eventId of ctx.runtime.pendingConfirmations) {
          // Find the matching agent.tool_use or agent.custom_tool_use event
          const toolUseEvent = recentEvents.find((e: SessionEvent) => {
            if (e.type === "agent.tool_use") {
              return (e as AgentToolUseEvent).id === eventId;
            }
            if (e.type === "agent.custom_tool_use") {
              return (e as import("@open-managed-agents/shared").AgentCustomToolUseEvent).id === eventId;
            }
            return false;
          });
          if (toolUseEvent) {
            if (toolUseEvent.type === "agent.tool_use") {
              const tue = toolUseEvent as AgentToolUseEvent;
              pendingCalls.push({ toolCallId: tue.id, toolName: tue.name, args: tue.input });
            } else if (toolUseEvent.type === "agent.custom_tool_use") {
              const cte = toolUseEvent as import("@open-managed-agents/shared").AgentCustomToolUseEvent;
              pendingCalls.push({ toolCallId: cte.id, toolName: cte.name, args: cte.input });
            }
          }
        }
        if (pendingCalls.length) {
          this.setMeta("pending_tool_calls", JSON.stringify(pendingCalls));
        }
      }

      // Outcome self-evaluation loop (properly loops until satisfied or max iterations)
      const outcomeJson = this.getMeta("outcome");
      if (outcomeJson) {
        const outcome = JSON.parse(outcomeJson);
        let iteration = parseInt(this.getMeta("outcome_iteration") || "1", 10);
        const maxIterations = Math.min(outcome.max_iterations || 3, 20);
        const outcomeModelId = typeof agent.model === "string" ? agent.model : agent.model?.id;
        const model = resolveModel(outcomeModelId || ctx.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", ctx.env.ANTHROPIC_API_KEY, ctx.env.ANTHROPIC_BASE_URL);

        while (iteration <= maxIterations) {
          // Collect agent output from recent events
          const recentEvents = history.getEvents();
          const agentOutput = recentEvents
            .filter((e: SessionEvent) => e.type === "agent.message")
            .map((e: SessionEvent) => {
              const msg = e as AgentMessageEvent;
              return msg.content?.map((b) => b.type === "text" ? b.text : "").join("") || "";
            })
            .join("\n");

          // Span: outcome evaluation start
          this.broadcastEvent({ type: "span.outcome_evaluation_start", iteration });

          const ongoingEvent: SessionEvent = {
            type: "span.outcome_evaluation_ongoing",
            iteration,
          };
          history.append(ongoingEvent);
          this.broadcastEvent(ongoingEvent);

          const evalResult = await evaluateOutcome(model, outcome, agentOutput);

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
            break;
          }

          if (iteration >= maxIterations) {
            const evalEvent: OutcomeEvaluationEvent = {
              type: "outcome.evaluation_end",
              result: "max_iterations_reached",
              iteration,
            };
            history.append(evalEvent);
            this.broadcastEvent(evalEvent);
            this.setMeta("outcome", "");
            break;
          }

          // Needs revision — inject feedback and re-run
          const evalEvent: OutcomeEvaluationEvent = {
            type: "outcome.evaluation_end",
            result: "needs_revision",
            iteration,
            feedback: evalResult.feedback,
          };
          history.append(evalEvent);
          this.broadcastEvent(evalEvent);

          iteration += 1;
          this.setMeta("outcome_iteration", String(iteration));

          const feedbackMsg: UserMessageEvent = {
            type: "user.message",
            content: [{
              type: "text",
              text: `[Outcome Evaluation - Iteration ${iteration - 1}] Needs revision:\n${evalResult.feedback}\n\nPlease address the feedback and try again.`,
            }],
          };
          history.append(feedbackMsg);
          this.broadcastEvent(feedbackMsg);
          await harness.run({ ...ctx, userMessage: feedbackMsg });
        }
      }

      // Determine stop reason based on pending tool confirmations or custom tool results
      const pendingConfirmations = ctx.runtime.pendingConfirmations || [];

      // Check if any pending are custom tool uses (no execute function, not always_ask built-in)
      const pendingToolCallsJson = this.getMeta("pending_tool_calls");
      const storedPendingCalls: PendingToolCall[] = pendingToolCallsJson ? JSON.parse(pendingToolCallsJson) : [];
      const hasCustomToolPending = storedPendingCalls.some(p =>
        !["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"].includes(p.toolName) &&
        !p.toolName.startsWith("mcp_") &&
        !p.toolName.startsWith("call_agent_") &&
        !p.toolName.startsWith("memory_")
      );

      let stopReason: import("@open-managed-agents/shared").SessionStatusEvent["stop_reason"];
      if (hasCustomToolPending) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "custom_tool_result" as const,
          event_ids: pendingConfirmations,
        };
      } else if (pendingConfirmations.length > 0) {
        stopReason = {
          type: "requires_action" as const,
          action_type: "tool_confirmation" as const,
          event_ids: pendingConfirmations,
        };
      } else {
        stopReason = { type: "end_turn" as const };
      }

      const idleEvent: SessionEvent = {
        type: "session.status_idle",
        stop_reason: stopReason,
      };
      history.append(idleEvent);
      this.broadcastEvent(idleEvent);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Don't retry if aborted
      if (err instanceof Error && err.name === "AbortError") {
        // Interrupt was handled — don't emit error
        return;
      }

      const TRANSIENT_PATTERNS = ["timeout", "network", "ECONNREFUSED", "fetch failed", "rate limit", "429", "503"];
      const isTransient = TRANSIENT_PATTERNS.some((p) => errorMessage.toLowerCase().includes(p.toLowerCase()));

      if (isTransient && retryCount < 2) {
        const rescheduledEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: errorMessage,
        };
        history.append(rescheduledEvent);
        this.broadcastEvent(rescheduledEvent);

        // Exponential backoff: 1s, 2s
        const delay = 1000 * Math.pow(2, retryCount);
        await new Promise(r => setTimeout(r, delay));
        return this.processUserMessage(userMessage, retryCount + 1, skipAppend);
      }

      if (isTransient) {
        const rescheduledEvent: SessionEvent = {
          type: "session.status_rescheduled",
          reason: `${errorMessage} (exhausted ${retryCount} retries)`,
        };
        history.append(rescheduledEvent);
        this.broadcastEvent(rescheduledEvent);
      }

      const errorEvent: SessionEvent = {
        type: "session.error",
        error: errorMessage,
      };
      history.append(errorEvent);
      this.broadcastEvent(errorEvent);

      // Harness crashed — but session is recoverable.
      // The event log has everything up to the crash point.
      // The sandbox is still alive (container persists independently).
      // Client can send a new user.message to retry.
    } finally {
      this.currentAbortController = null;
      this.setMeta("status", "idle");
    }
  }
}
