import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { bindAcpAgentState } from "../../../packages/acp-runtime/src/native-state";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import type {
  HarnessContext,
  HarnessRuntime,
} from "@open-managed-agents/agent/harness/interface";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { SessionStateMachine } from "@open-managed-agents/session-runtime";
import type { RuntimeAdapter } from "@open-managed-agents/session-runtime";
import { describe, expect, it, vi } from "vitest";

describe("ACP sandbox harness", () => {
  it("reuses one real ACP process across turns through SessionStateMachine", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-machine-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const agent = {
      id: "agent_acp_machine",
      name: "Machine-owned ACP sandbox agent",
      model: "unused-by-acp",
      system: "",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          id: "claude-acp",
          command: process.execPath,
          args: ["-e", fakeAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
    } as unknown as AgentConfig;
    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    let checkpointBeforeDestroy: string | undefined;
    const machine = new SessionStateMachine({
      sessionId: "session_acp_machine",
      tenantId: "tenant_acp_machine",
      adapter,
      sandbox,
      loadAgent: async () => agent,
      buildModel: () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarness: () => {
        const harness = resolveHarness("acp-sandbox");
        return {
          run: (ctx) => harness.run(ctx as HarnessContext),
          dispose: (reason) => harness.dispose?.(reason) ?? Promise.resolve(),
        };
      },
      buildHarnessContext: async ({ userMessage }) => ({
        ...createContext(agent, runtime, ""),
        session_id: "session_acp_machine",
        userMessage,
      }),
      beforeSandboxDestroy: async () => {
        checkpointBeforeDestroy = await sandbox.readFile(
          "/workspace/.openma/harness-state/acp/session_acp_machine/claude-code/v1/acp-session.json",
        );
      },
      publish: () => {},
    });

    try {
      await machine.runHarnessTurn(
        agent.id,
        createUserMessage("first"),
      );
      await machine.runHarnessTurn(
        agent.id,
        createUserMessage("second"),
      );

      expect(events.filter((event) => event.type === "agent.message")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:1:first" }],
        }),
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:2:second" }],
        }),
      ]);
      const modelEnds = events.filter((event) => event.type === "span.model_request_end");
      expect(modelEnds).toEqual([
        expect.objectContaining({
          model_usage: expect.objectContaining({
            input_tokens: 1_200,
            output_tokens: 20,
            cache_read_input_tokens: 0,
          }),
        }),
        expect.objectContaining({
          model_usage: expect.objectContaining({
            input_tokens: 120,
            output_tokens: 12,
            cache_read_input_tokens: 1_080,
          }),
        }),
      ]);
      const modelStarts = events.filter((event) => event.type === "span.model_request_start");
      expect(modelEnds.map((event) =>
        (event as { model_request_start_id?: string }).model_request_start_id
      )).toEqual(modelStarts.map((event) => event.id));
      const stateBinding = bindAcpAgentState({
        sessionId: "session_acp_machine",
        agent: agent.acp!.agent,
      });
      await expect(sandbox.readFile("state-path.txt")).resolves.toBe(
        stateBinding.nativePath,
      );
      const manifest = JSON.parse(await sandbox.readFile(
        "/workspace/.openma/harness-state/acp/session_acp_machine/claude-code/v1/session-binding.json",
      ));
      expect(manifest.session_artifacts).toEqual(stateBinding.sessionArtifacts);
    } finally {
      await machine.shutdown();
    }
    expect(JSON.parse(checkpointBeforeDestroy ?? "null")).toEqual(
      expect.objectContaining({ acpSessionId: "sandbox-acp-session" }),
    );
  });

  it("keeps one ACP process across turns and projects its events", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-harness-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    let leaseRenewals = 0;
    Object.assign(sandbox, {
      runtimeHandle: () => ({ provider: "local-test", runtimeId: "runtime-acp" }),
      runtimeCapabilities: () => ({ lease: true, suspend: [], checkpoint: [] }),
      status: async () => "running",
      renewLease: async () => { leaseRenewals += 1; },
      suspend: async () => { throw new Error("unexpected suspend"); },
      resume: async () => { throw new Error("unexpected resume"); },
      checkpoint: async () => { throw new Error("unexpected checkpoint"); },
    });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const harness = resolveHarness("acp-sandbox");
    const agent = {
      id: "agent_acp_sandbox",
      name: "ACP sandbox agent",
      model: "unused-by-acp",
      system: "Always answer from the sandbox ACP process.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          command: process.execPath,
          args: ["-e", fakeAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
    } as unknown as AgentConfig;

    try {
      const first = createContext(agent, runtime, "first");
      await harness.onSessionInit?.(first, runtime);
      await harness.run(first);
      await harness.run(createContext(agent, runtime, "second"));

      await expect(sandbox.readFile("/workspace/AGENTS.md")).resolves.toBe(
        "Always answer from the sandbox ACP process.\n",
      );
      expect(events.filter((event) => event.type === "agent.message")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:1:first" }],
        }),
        expect.objectContaining({
          content: [{ type: "text", text: "sandbox-acp:2:second" }],
        }),
      ]);
      expect(leaseRenewals).toBe(2);
    } finally {
      await (harness as { dispose?: () => Promise<void> }).dispose?.();
      await sandbox.destroy();
    }
  });

  it("deletes the isolated native session on logical harness destruction", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-session-destroy-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const harness = resolveHarness("acp-sandbox");
    const agent = {
      id: "agent_acp_session_destroy",
      name: "Destroyable ACP session",
      model: "unused-by-acp",
      system: "",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          id: "claude-acp",
          command: process.execPath,
          args: ["-e", fakeAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-09-03T00:00:00.000Z",
    } as unknown as AgentConfig;
    const root =
      "/workspace/.openma/harness-state/acp/session_acp_sandbox/claude-code/v1";

    try {
      await harness.run(createContext(agent, runtime, "one turn"));
      await sandbox.writeFile(`${root}/native/non-session-config.json`, "private");
      await harness.dispose?.("destroy");

      await expect(sandbox.readFile(`${root}/session-binding.json`))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(sandbox.readFile(`${root}/native/non-session-config.json`))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await harness.dispose?.("destroy");
      await sandbox.destroy();
    }
  });

  it("runs the same stateful ACP harness through the E2B adapter", async () => {
    const service = new ScriptedE2BService();
    const sandbox = new E2BSandboxExecutor(service.sandbox as never, {});
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const agent = {
      id: "agent_acp_e2b",
      name: "E2B ACP sandbox agent",
      model: "unused-by-acp",
      system: "Keep the ACP process alive across E2B turns.",
      tools: [],
      mcp_servers: [{
        name: "linear",
        type: "url",
        url: "https://linear.example/mcp",
        authorization_token: "must-never-reach-the-sandbox",
      }],
      harness: "acp-sandbox",
      acp: {
        agent: {
          command: "acp-agent",
          args: ["--stdio"],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-09-02T00:00:00.000Z",
    } as unknown as AgentConfig;
    const adapter = {
      beginTurn: async () => {},
      endTurn: async () => {},
      listOrphanTurns: async () => [],
    } as unknown as RuntimeAdapter;
    let checkpointBeforeDestroy: string | undefined;
    const machine = new SessionStateMachine({
      sessionId: "session_acp_e2b",
      tenantId: "tenant_acp_e2b",
      adapter,
      sandbox,
      loadAgent: async () => agent,
      buildModel: () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarness: () => {
        const harness = resolveHarness("acp-sandbox");
        return {
          run: (ctx) => harness.run(ctx as HarnessContext),
          dispose: (reason) => harness.dispose?.(reason) ?? Promise.resolve(),
        };
      },
      buildHarnessContext: async ({ userMessage }) => ({
        ...createContext(agent, runtime, ""),
        session_id: "session_acp_e2b",
        env: {
          mcpProxy: {
            gatewayBaseUrl: "https://api.openma.test",
            sessionsToken: "sk-ant-req-v1.current-work",
          },
        },
        userMessage,
      }),
      beforeSandboxDestroy: async () => {
        checkpointBeforeDestroy = await sandbox.readFile(
          "/workspace/.openma/harness-state/acp/session_acp_e2b/opaque/v1/acp-session.json",
        );
      },
      publish: () => {},
    });

    await machine.runHarnessTurn(agent.id, createUserMessage("first"));
    await machine.runHarnessTurn(agent.id, createUserMessage("second"));
    await machine.shutdown();

    expect(events.filter((event) => event.type === "agent.message")).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "e2b-acp:1:first" }],
      }),
      expect.objectContaining({
        content: [{ type: "text", text: "e2b-acp:2:second" }],
      }),
    ]);
    expect(service.processStarts).toBe(1);
    expect(service.sessionNewParams?.mcpServers).toEqual([{
      type: "http",
      name: "linear",
      url: "https://api.openma.test/v1/oma/mcp-proxy/session_acp_e2b/linear",
      headers: [{
        name: "Authorization",
        value: "Bearer sk-ant-req-v1.current-work",
      }],
    }]);
    expect(JSON.stringify(service.sessionNewParams)).not.toContain(
      "must-never-reach-the-sandbox",
    );
    expect(service.leaseTtls).toEqual([90_000, 90_000]);
    expect(JSON.parse(checkpointBeforeDestroy ?? "null")).toEqual(
      expect.objectContaining({ acpSessionId: "e2b-acp-session" }),
    );
    expect(service.lifecycle.indexOf("session/close")).toBeGreaterThanOrEqual(0);
    expect(service.lifecycle.indexOf("process/kill")).toBeGreaterThan(
      service.lifecycle.indexOf("session/close"),
    );
    expect(service.lifecycle.at(-1)).toBe("sandbox/kill");
  });

  it("recovers a crashed sandbox ACP child through its native session id", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-harness-recovery-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const firstHarness = resolveHarness("acp-sandbox");
    let recoveredHarness: ReturnType<typeof resolveHarness> | undefined;
    const agent = {
      id: "agent_acp_sandbox_recovery",
      name: "Recovering ACP sandbox agent",
      model: "unused-by-acp",
      system: "Recover the native ACP session after a child crash.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          id: "claude-acp",
          command: process.execPath,
          args: ["-e", recoveringAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
    } as unknown as AgentConfig;

    let restoredSandbox: LocalSubprocessSandbox | undefined;
    let checkpointRoot: string | undefined;
    try {
      const first = createContext(agent, runtime, "first");
      await firstHarness.onSessionInit?.(first, runtime);
      await firstHarness.run(first);
      await expect.poll(
        () => sandbox.exec("test -f first-child-exited && echo yes || echo no"),
      ).toBe("yes");
      // The marker is written immediately before process.exit(); wait for
      // the OS exit notification to reach the placement liveness wrapper.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Materialize a provider-neutral checkpoint, delete the original
      // sandbox, and restore it into a fresh runtime. This proves recovery
      // from files rather than accidental reuse of either process memory or
      // the original sandbox instance.
      await firstHarness.dispose?.("shutdown");
      checkpointRoot = await mkdtemp(
        join(tmpdir(), "oma-acp-harness-checkpoint-"),
      );
      const restoredWorkdir = join(checkpointRoot, "workspace");
      await cp(workdir, restoredWorkdir, { recursive: true });
      await sandbox.destroy();
      restoredSandbox = new LocalSubprocessSandbox({ workdir: restoredWorkdir });
      const restoredRuntime = createRuntime(restoredSandbox, events);

      // A fresh harness instance models a Worker/DO isolate restart. The old
      // in-memory session id is gone; both the ACP id and the agent-native
      // transcript must come from the restored workspace checkpoint.
      recoveredHarness = resolveHarness("acp-sandbox");
      await recoveredHarness.run(
        createContext(agent, restoredRuntime, "second"),
      );

      expect(events.filter((event) => event.type === "agent.message")).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "new:first" }],
        }),
        expect.objectContaining({
          content: [{
            type: "text",
            text: "resume:sandbox-acp-recovery:native=first:second",
          }],
        }),
      ]);
      expect(events.filter((event) => event.type === "span.model_request_end"))
        .toEqual([
          expect.objectContaining({
            model_usage: expect.objectContaining({
              input_tokens: 1_200,
              cache_read_input_tokens: 0,
            }),
          }),
          expect.objectContaining({
            model_usage: expect.objectContaining({
              input_tokens: 120,
              cache_read_input_tokens: 1_080,
            }),
          }),
        ]);
    } finally {
      await (recoveredHarness as { dispose?: () => Promise<void> } | undefined)
        ?.dispose?.();
      await restoredSandbox?.destroy();
      await sandbox.destroy();
      if (checkpointRoot !== undefined) {
        await rm(checkpointRoot, { recursive: true, force: true });
      }
    }
  });

  it("falls back to one canonical recovery prompt when native ACP state is missing", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-acp-semantic-recovery-"));
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const events: SessionEvent[] = [];
    const runtime = createRuntime(sandbox, events);
    registerCoreHarnesses();
    const firstHarness = resolveHarness("acp-sandbox");
    let recoveredHarness: ReturnType<typeof resolveHarness> | undefined;
    const agent = {
      id: "agent_acp_semantic_recovery",
      name: "Semantic recovery ACP sandbox agent",
      model: "unused-by-acp",
      system: "Recover safely without repeating completed side effects.",
      tools: [],
      harness: "acp-sandbox",
      acp: {
        agent: {
          id: "claude-acp",
          command: process.execPath,
          args: ["-e", recoveringAcpAgentSource],
          cwd: "/workspace",
        },
      },
      version: 1,
      created_at: "2026-09-03T00:00:00.000Z",
    } as unknown as AgentConfig;

    let restoredSandbox: LocalSubprocessSandbox | undefined;
    let checkpointRoot: string | undefined;
    try {
      const first = createContext(agent, runtime, "create the report");
      events.push(first.userMessage);
      await firstHarness.onSessionInit?.(first, runtime);
      await firstHarness.run(first);
      await expect.poll(
        () => sandbox.exec("test -f first-child-exited && echo yes || echo no"),
      ).toBe("yes");
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Canonical events remain the recovery source of truth. A completed tool
      // is included for continuity, but its raw input must not be replayed.
      events.splice(1, 0,
        {
          type: "agent.tool_use",
          id: "tool_write_report",
          name: "bash",
          input: { command: "touch /workspace/should-not-repeat" },
        } as SessionEvent,
        {
          type: "agent.tool_result",
          tool_use_id: "tool_write_report",
          content: "created /workspace/report.md",
        } as SessionEvent,
      );

      await firstHarness.dispose?.("shutdown");
      checkpointRoot = await mkdtemp(
        join(tmpdir(), "oma-acp-semantic-checkpoint-"),
      );
      const restoredWorkdir = join(checkpointRoot, "workspace");
      await cp(workdir, restoredWorkdir, { recursive: true });
      await rm(join(
        restoredWorkdir,
        ".openma/harness-state/acp/session_acp_sandbox/claude-code/v1/native/projects",
      ), { recursive: true, force: true });
      await sandbox.destroy();

      restoredSandbox = new LocalSubprocessSandbox({ workdir: restoredWorkdir });
      const restoredRuntime = createRuntime(restoredSandbox, events);
      recoveredHarness = resolveHarness("acp-sandbox");
      await recoveredHarness.run(
        createContext(agent, restoredRuntime, "continue with the next section"),
      );

      const messages = events.filter((event) => event.type === "agent.message");
      expect(messages).toHaveLength(2);
      const recoveredText = (messages[1] as { content: Array<{ text?: string }> })
        .content[0]?.text ?? "";
      expect(recoveredText).toContain(
        'new:<openma-recovery version="1" reason="native-state-missing">',
      );
      expect(recoveredText).toContain("User: create the report");
      expect(recoveredText).toContain("Assistant: new:create the report");
      expect(recoveredText).toContain(
        "Completed tool bash: created /workspace/report.md",
      );
      expect(recoveredText).toContain(
        "Current request:\ncontinue with the next section",
      );
      expect(recoveredText).toContain("Do not repeat completed side effects");
      expect(recoveredText).not.toContain("touch /workspace/should-not-repeat");
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.warning",
        source: "acp_semantic_recovery",
        details: expect.objectContaining({ reason: "native-state-missing" }),
      }));
    } finally {
      await (recoveredHarness as { dispose?: () => Promise<void> } | undefined)
        ?.dispose?.();
      await restoredSandbox?.destroy();
      await sandbox.destroy();
      if (checkpointRoot !== undefined) {
        await rm(checkpointRoot, { recursive: true, force: true });
      }
    }
  });

  it.each(ACP_PROFILE_CASES)(
    "launches the %s ACP adapter in a real local sandbox",
    async (agentId, expectedAdapterId) => {
      const sessionId = `session_acp_profile_${agentId.replaceAll("-", "_")}`;
      const workdir = await mkdtemp(join(tmpdir(), `oma-acp-profile-${agentId}-`));
      const sandbox = new LocalSubprocessSandbox({ workdir });
      const events: SessionEvent[] = [];
      const runtime = createRuntime(sandbox, events);
      registerCoreHarnesses();
      const harness = resolveHarness("acp-sandbox");
      const agent = {
        id: `agent_${agentId}`,
        name: `${agentId} ACP adapter`,
        model: "unused-by-acp",
        system: "",
        tools: [],
        harness: "acp-sandbox",
        acp: {
          agent: {
            id: agentId,
            command: process.execPath,
            args: ["-e", profileAcpAgentSource],
            cwd: "/workspace",
            env: { PROFILE_AGENT_ID: agentId },
          },
        },
        version: 1,
        created_at: "2026-09-04T00:00:00.000Z",
      } as unknown as AgentConfig;

      try {
        await harness.run(createContext(
          agent,
          runtime,
          "exercise profile",
          sessionId,
        ));

        const binding = bindAcpAgentState({
          sessionId,
          agent: agent.acp!.agent,
        });
        const manifest = JSON.parse(await sandbox.readFile(
          `${binding.rootPath}/session-binding.json`,
        )) as { adapter_id: string; session_artifacts: unknown[] };
        expect(manifest.adapter_id).toBe(expectedAdapterId);
        expect(manifest.session_artifacts).toEqual(binding.sessionArtifacts);
        await expect(readFile(`${binding.nativePath}/started`, "utf8"))
          .resolves.toBe(agentId);
        expect(events).toContainEqual(expect.objectContaining({
          type: "agent.message",
          content: [{ type: "text", text: `profile:${agentId}` }],
        }));
      } finally {
        await harness.dispose?.("destroy");
        await sandbox.destroy();
      }
    },
  );
});

const ACP_PROFILE_CASES = [
  ["claude-acp", "claude-code"],
  ["codex-acp", "codex"],
  ["gemini-cli", "gemini"],
  ["opencode", "opencode"],
  ["pi-acp", "pi"],
  ["mcode", "mcode"],
  ["github-copilot-cli", "copilot"],
  ["cortex-code", "cortex-code"],
  ["goose", "goose"],
  ["junie", "junie"],
  ["kimi-cli", "kimi"],
  ["qwen-code", "qwen-code"],
  ["mistral-vibe", "mistral-vibe"],
  ["dsh-acp", "dsh"],
  ["hermes", "hermes"],
  ["aider-acp", "aider"],
  ["kimi-code", "kimi-code"],
  ["mimo", "mimo"],
] as const;

function createContext(
  agent: AgentConfig,
  runtime: HarnessRuntime,
  text: string,
  sessionId = "session_acp_sandbox",
): HarnessContext {
  return {
    agent,
    userMessage: {
      type: "user.message",
      content: [{ type: "text", text }],
    } as UserMessageEvent,
    session_id: sessionId,
    tools: {},
    model: {} as HarnessContext["model"],
    systemPrompt: agent.system,
    env: {},
    runtime,
  } as HarnessContext;
}

function createUserMessage(text: string): UserMessageEvent {
  return {
    type: "user.message",
    content: [{ type: "text", text }],
  } as UserMessageEvent;
}

function createRuntime(
  sandbox: SandboxPort,
  events: SessionEvent[],
): HarnessRuntime {
  return {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox,
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async () => {}),
    broadcastChunk: vi.fn(async () => {}),
    broadcastStreamEnd: vi.fn(async () => {}),
    broadcastThinkingStart: vi.fn(async () => {}),
    broadcastThinkingChunk: vi.fn(async () => {}),
    broadcastThinkingEnd: vi.fn(async () => {}),
    broadcastToolInputStart: vi.fn(async () => {}),
    broadcastToolInputChunk: vi.fn(async () => {}),
    broadcastToolInputEnd: vi.fn(async () => {}),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;
}

class ScriptedE2BService {
  readonly files = new Map<string, string>();
  readonly leaseTtls: number[] = [];
  readonly lifecycle: string[] = [];
  processStarts = 0;
  sessionNewParams: { mcpServers?: unknown[] } | null = null;
  #promptCount = 0;
  #activeProcess: { finish(): void } | null = null;

  readonly sandbox = {
    sandboxId: "e2b-runtime-acp-01",
    commands: {
      run: async (
        _command: string,
        options?: {
          background?: boolean;
          stdin?: boolean;
          onStdout?(data: string): void | Promise<void>;
        },
      ) => {
        if (!options?.background || !options.stdin) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        this.processStarts += 1;
        let input = "";
        let settled = false;
        let resolveWait!: (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
        }) => void;
        const wait = new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => { resolveWait = resolve; });
        const finish = () => {
          if (settled) return;
          settled = true;
          resolveWait({ stdout: "", stderr: "", exitCode: 0 });
        };
        this.#activeProcess = { finish };
        const send = async (message: unknown) => {
          const line = `${JSON.stringify(message)}\n`;
          // Exercise the real ACP stream parser rather than handing it one
          // conveniently framed JSON object per callback.
          const split = Math.max(1, Math.floor(line.length / 2));
          await options.onStdout?.(line.slice(0, split));
          await options.onStdout?.(line.slice(split));
        };
        const dispatch = async (line: string) => {
          const request = JSON.parse(line) as {
            id: string | number;
            method: string;
            params?: {
              prompt?: Array<{ text?: string }>;
            };
          };
          const result = (value: unknown) => send({
            jsonrpc: "2.0",
            id: request.id,
            result: value,
          });
          switch (request.method) {
            case "initialize":
              await result({
                protocolVersion: 1,
                agentCapabilities: {
                  sessionCapabilities: { close: {} },
                },
              });
              break;
            case "session/new":
              this.sessionNewParams = request.params ?? null;
              await result({ sessionId: "e2b-acp-session" });
              break;
            case "session/prompt": {
              this.#promptCount += 1;
              const text = (request.params?.prompt ?? [])
                .map((block) => block.text ?? "")
                .join("");
              await send({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "e2b-acp-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: `e2b-acp:${this.#promptCount}:${text}`,
                    },
                  },
                },
              });
              await result({ stopReason: "end_turn" });
              break;
            }
            case "session/close":
              this.lifecycle.push("session/close");
              await result({});
              break;
            case "session/cancel":
              await result({});
              break;
            default:
              await send({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: "Method not found" },
              });
          }
        };
        return {
          pid: 91,
          sendStdin: async (data: string | Uint8Array) => {
            input += typeof data === "string"
              ? data
              : new TextDecoder().decode(data);
            const lines = input.split("\n");
            input = lines.pop() ?? "";
            for (const line of lines) {
              if (line) await dispatch(line);
            }
          },
          closeStdin: async () => {},
          kill: async () => {
            this.lifecycle.push("process/kill");
            finish();
            return true;
          },
          wait: () => wait,
        };
      },
    },
    files: {
      read: async (path: string) => {
        const value = this.files.get(path);
        if (value === undefined) throw new Error(`file not found: ${path}`);
        return value;
      },
      write: async (path: string, data: string | Uint8Array) => {
        this.files.set(
          path,
          typeof data === "string" ? data : new TextDecoder().decode(data),
        );
      },
    },
    kill: async () => {
      this.lifecycle.push("sandbox/kill");
      this.#activeProcess?.finish();
    },
    getInfo: async () => ({ state: "running" }),
    setTimeout: async (ttlMs: number) => {
      this.leaseTtls.push(ttlMs);
    },
    pause: async () => true,
    connect: async () => this.sandbox,
    createSnapshot: async () => ({
      snapshotId: "e2b-snapshot-acp-01",
      names: ["e2b-snapshot-acp-01"],
    }),
  };
}

const fakeAcpAgentSource = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let promptCount = 0;
if (process.env.CLAUDE_CONFIG_DIR) {
  fs.writeFileSync("state-path.txt", process.env.CLAUDE_CONFIG_DIR);
}
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "sandbox-acp-session" });
      break;
    case "session/prompt": {
      promptCount += 1;
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "sandbox-acp:" + promptCount + ":" + text },
          },
        },
      });
      result({
        stopReason: "end_turn",
        usage: promptCount === 1
          ? {
              totalTokens: 1220,
              inputTokens: 1200,
              outputTokens: 20,
              cachedReadTokens: 0,
              cachedWriteTokens: 0,
            }
          : {
              totalTokens: 1212,
              inputTokens: 120,
              outputTokens: 12,
              cachedReadTokens: 1080,
              cachedWriteTokens: 0,
            },
      });
      break;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const recoveringAcpAgentSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const nativeRoot = process.env.CLAUDE_CONFIG_DIR;
if (!nativeRoot) throw new Error("missing CLAUDE_CONFIG_DIR state binding");
const nativeTranscript = path.join(nativeRoot, "projects", "session.jsonl");
let mode = "uninitialized";
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      });
      break;
    case "session/new":
      mode = "new";
      result({ sessionId: "sandbox-acp-recovery" });
      break;
    case "session/resume":
      if (!fs.existsSync(nativeTranscript)) {
        throw new Error("native transcript missing after restore");
      }
      mode = "resume:" + request.params.sessionId
        + ":native=" + JSON.parse(fs.readFileSync(nativeTranscript, "utf8")).text;
      result({});
      break;
    case "session/prompt": {
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: mode + ":" + text },
          },
        },
      });
      result({
        stopReason: "end_turn",
        usage: mode === "new"
          ? {
              totalTokens: 1220,
              inputTokens: 1200,
              outputTokens: 20,
              cachedReadTokens: 0,
              cachedWriteTokens: 0,
            }
          : {
              totalTokens: 1212,
              inputTokens: 120,
              outputTokens: 12,
              cachedReadTokens: 1080,
              cachedWriteTokens: 0,
            },
      });
      if (mode === "new") {
        fs.mkdirSync(path.dirname(nativeTranscript), { recursive: true });
        fs.writeFileSync(nativeTranscript, JSON.stringify({ text }) + "\n");
        setTimeout(() => {
          fs.writeFileSync("first-child-exited", "yes");
          process.exit(17);
        }, 10);
      }
      break;
    }
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;

const profileAcpAgentSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const agentId = process.env.PROFILE_AGENT_ID ?? "unknown";
const nativeRoot = process.env.OPENMA_ACP_STATE_ROOT + "/native";
fs.mkdirSync(nativeRoot, { recursive: true });
fs.writeFileSync(path.join(nativeRoot, "started"), agentId);
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      result({ sessionId: "profile-session-" + agentId });
      break;
    case "session/prompt":
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "profile:" + agentId },
          },
        },
      });
      result({ stopReason: "end_turn" });
      break;
    case "session/close":
      result({});
      break;
    case "session/cancel":
      result({});
      break;
    default:
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
});
`;
