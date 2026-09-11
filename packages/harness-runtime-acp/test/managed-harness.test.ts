import type { AcpRuntime, SessionOptions } from "@open-managed-agents/acp-runtime";
import type { SessionCommand } from "@openma/common/session-kernel";
import { describe, expect, it, vi } from "vitest";

import {
  createManagedAcpSupervisorHarness,
  type ManagedHarnessControlChannel,
  type ManagedHarnessControlMessage,
  type ManagedHarnessPublishedEvent,
  type ManagedHarnessSessionStatePort,
} from "../src/index";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function commandChannel(commands: readonly SessionCommand[], log: string[]) {
  const published: ManagedHarnessPublishedEvent[] = [];
  const channel: ManagedHarnessControlChannel = {
    async *commands() {
      for (const command of commands) yield command;
      yield { type: "control.complete", workId: scope.workId };
    },
    async publish(event) {
      const diagnostic = event as unknown as {
        type: string;
        source?: string;
        details?: { reason?: string };
      };
      log.push([
        "publish",
        diagnostic.type,
        diagnostic.source,
        diagnostic.details?.reason,
      ].filter((part) => part !== undefined).join(":"));
      published.push(event);
    },
    close: vi.fn(async () => { log.push("control:close"); }),
  };
  return { channel, published };
}

function abruptlyClosedChannel(
  commands: readonly ManagedHarnessControlMessage[],
  log: string[],
): ManagedHarnessControlChannel {
  return {
    async *commands() {
      for (const command of commands) yield command;
    },
    async publish(event) { log.push(`publish:${event.type}`); },
    async close() { log.push("control:close"); },
  };
}

function fakeAcpRuntime(log: string[]): AcpRuntime {
  return {
    async start(options: SessionOptions) {
      log.push(`acp:start:${options.resumeAcpSessionId ?? "new"}`);
      return {
        id: "internal_1",
        acpSessionId: "acp_1",
        options,
        authMethods: [],
        protocolVersion: null,
        agentInfo: null,
        agentCapabilities: {},
        initializeMeta: null,
        sessionSetupMeta: null,
        configOptions: [],
        modes: null,
        promptCapabilities: {},
        supportsSessionFork: false,
        supportsSessionList: false,
        supportsSessionDelete: false,
        supportsSessionResume: true,
        supportsSessionClose: true,
        supportsAdditionalDirectories: false,
        supportsLogout: false,
        supportsProviders: false,
        supportsNes: false,
        nesCapabilities: null,
        positionEncoding: null,
        supportsSteering: false,
        async *prompt(text: string | readonly unknown[]) {
          log.push(`acp:prompt:${String(text)}`);
          yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } };
          yield {
            type: "promptComplete",
            response: { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 8 } },
          };
        },
        async steer() { return "promptRequired" as const; },
        async cancelCurrentTurn() {},
        drainPendingEvents() { return []; },
        async setConfigOption() { return []; },
        async authenticate() {},
        async setMode() {},
        async listSessions() { return { sessions: [] }; },
        async deleteSession() {},
        async logout() {},
        async listProviders() { return { providers: [] }; },
        async setProvider() {},
        async disableProvider() {},
        async requestExtension() { return {}; },
        async notifyExtension() {},
        async startNes() { return {}; },
        async suggestNes() { return {}; },
        async closeNes() {},
        async didOpenDocument() {},
        async didChangeDocument() {},
        async didCloseDocument() {},
        async didSaveDocument() {},
        async didFocusDocument() {},
        async acceptNes() {},
        async rejectNes() {},
        isAlive() { return true; },
        async dispose() { log.push("acp:dispose"); },
      } as never;
    },
  };
}

describe("managed ACP harness in sandbox", () => {
  it("runs the Session command loop inside the supervisor and checkpoints before completion publication", async () => {
    const log: string[] = [];
    const { channel, published } = commandChannel([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "codex-acp",
        runtime: "cloud",
        acpSessionId: "old_acp",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_1",
        text: "ship it",
      },
    ], log);
    const state: ManagedHarnessSessionStatePort = {
      async beforeStart(command) {
        log.push("state:restore");
        return { command };
      },
      async onReady() { log.push("state:ready"); },
      async checkpoint() { log.push("state:checkpoint"); },
      async release(input) { log.push(`state:release:${input.reason}`); },
    };
    const harness = createManagedAcpSupervisorHarness({
      connect: async (input) => {
        expect(input).toMatchObject({
          scope,
          harness: { id: "acp", version: "1" },
          workspacePath: "/workspace",
          outputPath: "/mnt/session/outputs",
        });
        return channel;
      },
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: {
        async prepare(command) {
          return {
            agent: { command: command.agentId },
            ...(command.acpSessionId ? { resumeAcpSessionId: command.acpSessionId } : {}),
          };
        },
      },
      sessionState: state,
      drainDeadlineMs: 100,
    });

    const run = await harness.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: "/mnt/session/outputs",
      checkpoint: async (checkpoint) => {
        log.push(`host:checkpoint:${checkpoint.turnId ?? "shutdown"}`);
      },
      signal: new AbortController().signal,
    });
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();

    expect(log.indexOf("state:checkpoint")).toBeLessThan(
      log.indexOf("publish:session.complete"),
    );
    expect(log.indexOf("publish:session.complete")).toBeLessThan(
      log.indexOf("host:checkpoint:turn_1"),
    );
    expect(log).toContain("state:restore");
    expect(log).toContain("state:ready");
    expect(log).toContain("state:release:shutdown");
    expect(published.map((event) => event.type)).toEqual([
      "session.ready",
      "session.event",
      "session.event",
      "session.complete",
    ]);
  });

  it.each([
    "native-state-missing",
    "native-state-stale",
  ] as const)("uses one semantic recovery prompt when native state is %s", async (reason) => {
    const log: string[] = [];
    const { channel } = commandChannel([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "codex-acp",
        runtime: "cloud",
        acpSessionId: "stale_acp",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_1",
        text: "continue",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_2",
        text: "next",
      },
    ], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: {
        async prepare(command) {
          return { agent: { command: command.agentId } };
        },
      },
      sessionState: {
        async beforeStart(command) {
          return {
            command: { ...command, acpSessionId: undefined },
            semanticRecoveryReason: reason,
          };
        },
        async onReady() {},
        async checkpoint() {},
        async release() {},
      },
      semanticRecovery: {
        async build(input) {
          return `recovered:${input.currentPrompt}`;
        },
      },
      drainDeadlineMs: 100,
    });

    const run = await harness.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await run.completed;

    expect(log).toContain("acp:start:new");
    expect(log).toContain("acp:prompt:recovered:continue");
    expect(log).toContain("acp:prompt:next");
    expect(log).toContain(
      `publish:session.warning:acp_semantic_recovery:${reason}`,
    );
    expect(log.indexOf(`publish:session.warning:acp_semantic_recovery:${reason}`))
      .toBeLessThan(log.indexOf("acp:prompt:recovered:continue"));
  });

  it("destroys native state on logical Session disposal", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "pi-acp",
        runtime: "cloud",
      },
      { type: "session.dispose", sessionId: scope.sessionId },
    ], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "pi-acp" } }; } },
      sessionState: {
        async beforeStart(command) { return { command }; },
        async onReady() {},
        async checkpoint() {},
        async release(input) { log.push(`state:release:${input.reason}`); },
      },
      drainDeadlineMs: 100,
    });

    const run = await harness.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: new AbortController().signal,
    });
    await run.completed;

    expect(log).toContain("state:release:destroy");
    expect(log).not.toContain("state:release:shutdown");
  });

  it("rejects cross-session commands before they reach ACP", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([{
      type: "session.start",
      sessionId: "session_intruder",
      agentId: "codex-acp",
      runtime: "cloud",
    }], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: inertState(),
    });

    const run = await startHarness(harness);
    await expect(run.completed).rejects.toThrow(
      "Harness control attempted cross-session command session_intruder",
    );
  });

  it("rejects a completion command claimed for another Work", async () => {
    const log: string[] = [];
    const channel = abruptlyClosedChannel([{
      type: "control.complete",
      workId: "work_intruder",
    }], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: inertState(),
    });

    const run = await startHarness(harness);
    await expect(run.completed).rejects.toThrow(
      "Harness control attempted cross-work completion work_intruder",
    );
    await run.stop("failed");
  });

  it("fails closed when native state is missing without semantic recovery", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "codex-acp",
        runtime: "cloud",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_missing",
        text: "continue",
      },
    ], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: {
        ...inertState(),
        async beforeStart(command) {
          return { command, semanticRecoveryReason: "native-state-missing" };
        },
      },
    });

    const run = await startHarness(harness);
    await expect(run.completed).rejects.toThrow(
      "Native ACP state is unavailable and no semantic recovery Port is configured",
    );
  });

  it("surfaces workspace CAS failure after canonical completion publication", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([
      {
        type: "session.start",
        sessionId: scope.sessionId,
        agentId: "codex-acp",
        runtime: "cloud",
      },
      {
        type: "session.prompt",
        sessionId: scope.sessionId,
        turnId: "turn_cas_failure",
        text: "commit this",
      },
    ], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: {
        async prepare() { return { agent: { command: "codex-acp" } }; },
      },
      sessionState: {
        async beforeStart(command) { return { command }; },
        async onReady() {},
        async checkpoint(input) {
          log.push(`state:checkpoint:${input.turnId ?? "shutdown"}`);
        },
        async release(input) { log.push(`state:release:${input.reason}`); },
      },
    });

    const run = await harness.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      async checkpoint(input) {
        log.push(`host:checkpoint:${input.turnId ?? "shutdown"}`);
        if (input.turnId !== undefined) throw new Error("workspace CAS failed");
      },
      signal: new AbortController().signal,
    });

    await expect(run.completed).rejects.toThrow("workspace CAS failed");
    expect(log.indexOf("state:checkpoint:turn_cas_failure")).toBeLessThan(
      log.indexOf("publish:session.complete"),
    );
    expect(log.indexOf("publish:session.complete")).toBeLessThan(
      log.indexOf("host:checkpoint:turn_cas_failure"),
    );
    await run.stop("failed");
    expect(log).toContain("state:checkpoint:shutdown");
    expect(log).toContain("state:release:shutdown");
  });

  it("releases materialized native state when ACP startup fails before ready", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([{
      type: "session.start",
      sessionId: scope.sessionId,
      agentId: "codex-acp",
      runtime: "cloud",
    }], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: {
        async start() {
          throw new Error("ACP failed during initialize");
        },
      },
      sessionPreparation: {
        async prepare() { return { agent: { command: "codex-acp" } }; },
      },
      sessionState: {
        async beforeStart(command) {
          log.push("state:materialized");
          return { command };
        },
        async onReady() { log.push("state:ready"); },
        async checkpoint() { log.push("state:checkpoint"); },
        async release(input) { log.push(`state:release:${input.reason}`); },
      },
    });

    const run = await startHarness(harness);
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();

    expect(log).toContain("publish:session.error");
    expect(log).not.toContain("state:ready");
    expect(log).not.toContain("state:checkpoint");
    expect(log.filter((entry) => entry === "state:release:shutdown")).toHaveLength(1);
  });

  it("fails closed when the control stream ends without an explicit work completion", async () => {
    const log: string[] = [];
    const channel = abruptlyClosedChannel([{
      type: "session.start",
      sessionId: scope.sessionId,
      agentId: "codex-acp",
      runtime: "cloud",
    }], log);
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: inertState(),
    });

    const run = await startHarness(harness);
    await expect(run.completed).rejects.toThrow(
      "Harness control stream closed before control.complete",
    );
    await run.stop("failed");
  });

  it("stops a blocked control stream, checkpoints once, and treats abort as clean exit", async () => {
    const log: string[] = [];
    let releaseCommands!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseCommands = resolve; });
    const channel: ManagedHarnessControlChannel = {
      async *commands(signal) {
        yield {
          type: "session.start",
          sessionId: scope.sessionId,
          agentId: "codex-acp",
          runtime: "cloud",
        };
        await Promise.race([
          waiting,
          new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
      },
      async publish(event) { log.push(`publish:${event.type}`); },
      async close() { log.push("control:close"); releaseCommands(); },
    };
    const state: ManagedHarnessSessionStatePort = {
      async beforeStart(command) { return { command }; },
      async onReady() {},
      async checkpoint() { log.push("state:checkpoint"); },
      async release(input) { log.push(`state:release:${input.reason}`); },
    };
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: state,
      drainDeadlineMs: 100,
      drainPollIntervalMs: 1,
      abortGraceMs: 0,
    });

    const run = await startHarness(harness);
    await vi.waitFor(() => expect(log).toContain("publish:session.ready"));
    await run.stop("aborted");
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.stop("failed");

    expect(log.filter((entry) => entry === "state:checkpoint")).toHaveLength(1);
    expect(log).toContain("state:release:shutdown");
    expect(log.filter((entry) => entry === "control:close")).toHaveLength(1);
  });

  it("suppresses an in-flight publication failure after the Work is fenced", async () => {
    const log: string[] = [];
    let publicationStarted!: () => void;
    const started = new Promise<void>((resolve) => { publicationStarted = resolve; });
    let rejectPublication!: (error: Error) => void;
    const publication = new Promise<void>((_, reject) => { rejectPublication = reject; });
    const channel: ManagedHarnessControlChannel = {
      async *commands(signal) {
        yield {
          type: "session.start",
          sessionId: scope.sessionId,
          agentId: "codex-acp",
          runtime: "cloud",
        };
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async publish(event) {
        log.push(`publish:${event.type}`);
        if (event.type === "session.ready") {
          publicationStarted();
          await publication;
        }
      },
      async close() { log.push("control:close"); },
    };
    const harness = createManagedAcpSupervisorHarness({
      connect: async () => channel,
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: inertState(),
      drainDeadlineMs: 100,
      drainPollIntervalMs: 1,
      abortGraceMs: 0,
    });

    const run = await startHarness(harness);
    await started;
    const stopped = run.stop("aborted");
    rejectPublication(new Error("late control-plane failure"));
    await expect(stopped).resolves.toBeUndefined();
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    expect(log).toContain("control:close");
  });

  it("inherits an already-aborted parent signal", async () => {
    const log: string[] = [];
    const { channel } = commandChannel([{
      type: "session.start",
      sessionId: scope.sessionId,
      agentId: "codex-acp",
      runtime: "cloud",
    }], log);
    const parent = new AbortController();
    parent.abort(new Error("host already stopped"));
    const harness = createManagedAcpSupervisorHarness({
      connect: async ({ signal }) => {
        expect(signal.aborted).toBe(true);
        return channel;
      },
      acpRuntime: fakeAcpRuntime(log),
      sessionPreparation: { async prepare() { return { agent: { command: "codex-acp" } }; } },
      sessionState: inertState(),
    });

    const run = await harness.start({
      scope,
      harness: { id: "acp", version: "1" },
      workspacePath: "/workspace",
      outputPath: null,
      checkpoint: async () => {},
      signal: parent.signal,
    });
    await expect(run.completed).resolves.toEqual({ exitCode: 0 });
    await run.drain();
    await run.drain();
  });

  it.each([
    [{ drainDeadlineMs: -1 }, "drainDeadlineMs must be a non-negative integer"],
    [{ drainDeadlineMs: 1.5 }, "drainDeadlineMs must be a non-negative integer"],
    [{ drainPollIntervalMs: 0 }, "drainPollIntervalMs must be a positive integer"],
    [{ drainPollIntervalMs: 1.5 }, "drainPollIntervalMs must be a positive integer"],
    [{ abortGraceMs: -1 }, "abortGraceMs must be a non-negative integer"],
    [{ abortGraceMs: 1.5 }, "abortGraceMs must be a non-negative integer"],
  ] as const)("rejects invalid timing option %j", (timing, message) => {
    expect(() => createManagedAcpSupervisorHarness({
      connect: async () => { throw new Error("unused"); },
      acpRuntime: fakeAcpRuntime([]),
      sessionPreparation: { async prepare() { return { agent: { command: "unused" } }; } },
      sessionState: inertState(),
      ...timing,
    })).toThrow(message);
  });
});

function inertState(): ManagedHarnessSessionStatePort {
  return {
    async beforeStart(command) { return { command }; },
    async onReady() {},
    async checkpoint() {},
    async release() {},
  };
}

async function startHarness(
  harness: ReturnType<typeof createManagedAcpSupervisorHarness>,
) {
  return harness.start({
    scope,
    harness: { id: "acp", version: "1" },
    workspacePath: "/workspace",
    outputPath: null,
    checkpoint: async () => {},
    signal: new AbortController().signal,
  });
}
