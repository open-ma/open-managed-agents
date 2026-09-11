import { describe, expect, it } from "vitest";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { Environment, Session, SessionEventView } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { decodeRuntimeProducedSessionEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import { MemorySessionThreadStore } from "../../../packages/session-thread-store-memory/src/index";
import { DefaultNodeManagedSessionRunner, type DefaultNodeManagedSessionRunnerDependencies } from "../src/lib/node-managed-session-runner";
import type { ManagedNodeSubagentControl } from "../src/lib/node-managed-subagents";
import type { ManagedNodeHarnessRuntime } from "../src/lib/node-managed-harness-runtime";

const session: Session = {
  id: "session_children", agent: { id: "parent", description: null, mcpServers: [],
    model: { id: "local-model" }, multiagent: null, name: "Parent", skills: [],
    system: "Parent instructions", tools: [], version: 1 }, archivedAt: null, budget: null,
  createdAt: "2026-09-11T00:00:00Z", environmentId: "env", metadata: {},
  outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null,
  updatedAt: "2026-09-11T00:00:00Z", usage: {}, vaultIds: [],
};
const environment: Environment = { id: "env", config: { type: "self_hosted" },
  archivedAt: null, createdAt: session.createdAt, updatedAt: session.updatedAt,
  name: "Shared", description: null, metadata: {} };

type Context = {
  session: Session;
  runtime: ManagedNodeHarnessRuntime;
  sandbox: SandboxExecutor;
  subagents?: ManagedNodeSubagentControl;
};

function fixture(run: (context: Context) => Promise<void>, store = new MemorySessionThreadStore(), options: {
  maxConcurrentSubagents?: number;
  output?(frame: Record<string, unknown>): Promise<void>;
} = {}) {
  const frames: Record<string, unknown>[] = [];
  const sandbox = { exec: async () => ({ stdout: "shared", stderr: "", exitCode: 0 }) } as unknown as SandboxExecutor;
  let id = 0;
  const deps: DefaultNodeManagedSessionRunnerDependencies = {
    buildSandbox: async () => sandbox,
    buildModel: async () => ({}) as HarnessContext["model"],
    buildTools: async () => ({}),
    buildHarnessContext: async (input) => input as unknown as HarnessContext,
    buildHarness: () => ({ run: async (context) => run(context as unknown as Context) }),
    confirmedTools: { execute: async () => { throw new Error("Unexpected confirmed tool"); } },
    outcomes: { evaluate: async () => { throw new Error("Unexpected outcome"); } },
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    ids: { nextEventId: () => `event_${++id}` },
    subagentThreads: store,
    subagentPolicy: () => ({ enabled: true, maxConcurrentSubagents: options.maxConcurrentSubagents ?? 2 }),
  };
  const runner = new DefaultNodeManagedSessionRunner(deps);
  return {
    runner, sandbox, frames, store,
    async run(history: SessionEventView[] = []) {
      await runner.start({ workspaceId: "workspace", sessionId: session.id, session, environment, initialEvents: [] });
      const message = { id: `input_${++id}`, type: "user.message" as const,
        content: [{ type: "text" as const, text: "Parent task" }], processedAt: session.createdAt };
      await runner.accept({ workspaceId: "workspace", sessionId: session.id, session, environment,
        initialEvents: [], historyEvents: [...history, message], events: [message],
        output: async (frame) => { frames.push(frame as Record<string, unknown>); await options.output?.(frame as Record<string, unknown>); } });
    },
  };
}

describe("Managed Node native subagents", () => {
  it("persists child identity and isolates its conversation while sharing the sandbox", async () => {
    let childId = "";
    const f = fixture(async ({ session: active, runtime, sandbox, subagents }) => {
      if (active.agent.name === "Parent") {
        expect(subagents).toBeDefined();
        const child = await subagents!.create({ name: "Researcher", instructions: "Inspect files", message: "Find answer", parentToolUseId: "tool_spawn" });
        childId = child.threadId;
        const result = await subagents!.wait({ threadIds: [childId] });
        expect(result).toMatchObject({ timedOut: false, subagents: [{ threadId: childId, status: "completed", output: "Found answer" }] });
        expect(JSON.stringify(runtime.history.getMessages())).not.toContain("Found answer");
      } else {
        expect(active.agent.system).toBe("Inspect files");
        expect(active.agent.model.id).toBe("local-model");
        expect(await sandbox.exec("pwd")).toMatchObject({ stdout: "shared" });
        expect(runtime.history.getMessages()).toEqual([{ role: "user", content: [{ type: "text", text: "Find answer" }] }]);
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Found answer" }] });
      }
    });
    await f.run();
    expect(await f.store.find({ workspaceId: "workspace", sessionId: session.id, threadId: childId })).toMatchObject({ parentThreadId: "sthr_primary", agent: { name: "Researcher", system: "Inspect files" } });
    expect(f.frames).toContainEqual(expect.objectContaining({ type: "session.thread_created", session_thread_id: childId, parent_thread_id: "sthr_primary", parent_tool_use_id: "tool_spawn" }));
    expect(f.frames).toContainEqual(expect.objectContaining({ type: "agent.message", session_thread_id: childId }));
    expect(f.frames.filter((frame) => frame.type === "session.status_idle")).toHaveLength(1);
  });

  it("restores a child from native thread and event facts for a later parent turn", async () => {
    let childId = "";
    const first = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        expect(subagents).toBeDefined();
        childId = (await subagents!.create({ name: "Worker", message: "First request" })).threadId;
        await subagents!.wait({ threadIds: [childId] });
      } else runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "First answer" }] });
    });
    await first.run();
    const facts = first.frames.map(decodeRuntimeProducedSessionEvent).filter((event): event is NonNullable<typeof event> => event !== null);
    const second = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        expect(JSON.stringify(runtime.history.getMessages())).not.toContain("First answer");
        await subagents!.send({ threadId: childId, message: "Follow up" });
        const result = await subagents!.wait({ threadIds: [childId] });
        expect(result.subagents[0]?.output).toBe("Second answer");
      } else {
        expect(runtime.history.getMessages()).toEqual([
          { role: "user", content: [{ type: "text", text: "First request" }] },
          { role: "assistant", content: [{ type: "text", text: "First answer" }] },
          { role: "user", content: [{ type: "text", text: "Follow up" }] },
        ]);
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Second answer" }] });
      }
    }, first.store);
    await second.run(facts);
    expect(second.frames.some((frame) => frame.type === "session.thread_created")).toBe(false);
  });

  it("interrupts only the selected child, enforces concurrency, and can resume a closed child", async () => {
    const f = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        expect(subagents).toBeDefined();
        const first = await subagents!.create({ name: "First", message: "Block" });
        const second = await subagents!.create({ name: "Second", message: "Block" });
        await expect(subagents!.create({ name: "Excess", message: "Block" })).rejects.toThrow(/concurren/i);
        const waiting = await subagents!.wait({ threadIds: [first.threadId, second.threadId], timeoutMs: 1 });
        expect(waiting.timedOut).toBe(true);
        await subagents!.interrupt({ threadId: first.threadId });
        const status = await subagents!.wait({ threadIds: [first.threadId, second.threadId] });
        expect(status.subagents).toMatchObject([{ status: "interrupted" }, { status: "running" }]);
        await subagents!.close({ threadId: second.threadId });
        expect((await subagents!.wait({ threadIds: [second.threadId] })).subagents[0]?.status).toBe("closed");
        await subagents!.resume({ threadId: second.threadId, message: "Finish" });
        expect((await subagents!.wait({ threadIds: [second.threadId] })).subagents[0]).toMatchObject({ status: "completed", output: "Done" });
      } else if (JSON.stringify(runtime.history.getMessages()).includes("Finish")) {
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Done" }] });
      } else {
        await new Promise<void>((resolve) => runtime.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
      }
    });
    await f.run();
  });

  it("keeps the parent execution open until unawaited children finish", async () => {
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const childMayFinish = new Promise<void>((resolve) => { finish = resolve; });
    const f = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        await subagents!.create({ name: "Worker", message: "Work" });
      } else {
        started();
        await childMayFinish;
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Finished" }] });
      }
    });
    const running = f.run();
    await childStarted;
    expect(f.frames.some((frame) => frame.type === "session.status_idle")).toBe(false);
    finish();
    await running;
    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle" });
    expect(f.frames.findIndex((frame) => frame.type === "session.thread_status_idle")).toBeLessThan(f.frames.length - 1);
  });

  it("cancels child providers when their parent execution is cancelled", async () => {
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const f = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        const child = await subagents!.create({ name: "Worker", message: "Work" });
        expect((await subagents!.wait({ threadIds: [child.threadId] })).subagents[0]?.status).toBe("interrupted");
      } else {
        const aborted = new Promise<void>((resolve) => runtime.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
        started();
        await aborted;
        await expect(runtime.sandbox.exec("write_after_cancellation")).rejects.toThrow();
      }
    });
    const running = f.run();
    await childStarted;
    f.runner.cancel({ workspaceId: "another_workspace", sessionId: session.id });
    expect(f.frames.some((frame) => frame.type === "session.thread_status_idle")).toBe(false);
    f.runner.cancel({ workspaceId: "workspace", sessionId: session.id });
    await running;
    expect(f.frames).toContainEqual(expect.objectContaining({ type: "session.thread_status_idle", interrupted: true }));
  });

  it("keeps child failures scoped to their thread and returns failed status to the parent", async () => {
    let childId = "";
    const f = fixture(async ({ session: active, subagents }) => {
      if (active.agent.name === "Parent") {
        childId = (await subagents!.create({ name: "Failing", message: "Fail" })).threadId;
        expect((await subagents!.wait({ threadIds: [childId] })).subagents[0]?.status).toBe("failed");
      } else throw new Error("Child provider failed");
    });
    await f.run();
    expect(f.frames.filter((frame) => frame.type === "session.error")).toEqual([
      expect.objectContaining({ session_thread_id: childId, error: expect.objectContaining({ message: "Child provider failed" }) }),
    ]);
  });

  it("queues input to a running child and delivers it after the current response", async () => {
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => { finish = resolve; });
    let turns = 0;
    const f = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        const child = await subagents!.create({ name: "Worker", message: "First" });
        await childStarted;
        expect(await subagents!.send({ threadId: child.threadId, message: "Follow up" })).toMatchObject({ status: "running" });
        finish();
        expect((await subagents!.wait({ threadIds: [child.threadId] })).subagents[0]?.output).toBe("Second answer");
      } else if (++turns === 1) {
        started();
        await Promise.race([mayFinish, new Promise<void>((resolve) => runtime.abortSignal!.addEventListener("abort", () => resolve(), { once: true }))]);
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "First answer" }] });
      } else {
        expect(runtime.history.getMessages()).toEqual([
          { role: "user", content: [{ type: "text", text: "First" }] },
          { role: "assistant", content: [{ type: "text", text: "First answer" }] },
          { role: "user", content: [{ type: "text", text: "Follow up" }] },
        ]);
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Second answer" }] });
      }
    });
    await f.run();
    expect(turns).toBe(2);
  });

  it("recovers queued messages after closing a child and restarting the Node runner", async () => {
    let childId = "";
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const first = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        childId = (await subagents!.create({ name: "Worker", message: "First" })).threadId;
        await childStarted;
        await subagents!.send({ threadId: childId, message: "Queued work" });
        await subagents!.close({ threadId: childId });
      } else {
        const aborted = new Promise<void>((resolve) => runtime.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
        started();
        await aborted;
      }
    });
    await first.run();
    const facts = first.frames.map(decodeRuntimeProducedSessionEvent).filter((event): event is NonNullable<typeof event> => event !== null);
    const second = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        expect((await subagents!.wait({ threadIds: [childId] })).subagents[0]?.status).toBe("closed");
        await subagents!.resume({ threadId: childId });
        expect((await subagents!.wait({ threadIds: [childId] })).subagents[0]?.output).toBe("Recovered");
      } else {
        expect(JSON.stringify(runtime.history.getMessages())).toContain("Queued work");
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Recovered" }] });
      }
    }, first.store);
    await second.run(facts);
    expect(second.frames.filter((frame) => frame.type === "agent.thread_message_received")).toHaveLength(1);
  });

  it("reopens a closed child without invoking the model when no input is pending", async () => {
    let calls = 0;
    const f = fixture(async ({ session: active, subagents }) => {
      if (active.agent.name === "Parent") {
        const child = await subagents!.create({ name: "Worker", message: "Work" });
        await subagents!.wait({ threadIds: [child.threadId] });
        await subagents!.close({ threadId: child.threadId });
        expect(await subagents!.resume({ threadId: child.threadId })).toMatchObject({ status: "idle" });
      } else calls += 1;
    });
    await f.run();
    expect(calls).toBe(1);
  });

  it("serializes simultaneous sends to one restored child into one execution owner", async () => {
    let childId = "";
    const first = fixture(async ({ subagents }) => { childId = (await subagents!.create({ name: "Worker" })).threadId; });
    await first.run();
    let activeCalls = 0;
    let peakCalls = 0;
    let calls = 0;
    const second = fixture(async ({ session: active, runtime, subagents }) => {
      if (active.agent.name === "Parent") {
        await Promise.all([subagents!.send({ threadId: childId, message: "One" }), subagents!.send({ threadId: childId, message: "Two" })]);
        await subagents!.wait({ threadIds: [childId] });
      } else {
        activeCalls += 1;
        peakCalls = Math.max(peakCalls, activeCalls);
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: `Answer ${calls}` }] });
        activeCalls -= 1;
      }
    }, first.store);
    await second.run();
    expect(calls).toBe(2);
    expect(peakCalls).toBe(1);
  });

  it("archives an inactive persisted child without trying to start or reload it", async () => {
    let childId = "";
    const first = fixture(async ({ subagents }) => { childId = (await subagents!.create({ name: "Worker" })).threadId; });
    await first.run();
    const second = fixture(async () => {
      const archived = await first.store.archive({ workspaceId: "workspace", sessionId: session.id,
        threadId: childId, archivedAt: session.createdAt });
      if (archived.type !== "archived") throw new Error("Missing child fixture");
      await second.runner.archiveThread({ workspaceId: "workspace", sessionId: session.id,
        threadId: childId, session, thread: archived.thread });
    }, first.store);
    await expect(second.run()).resolves.toBeUndefined();
  });

  it("serializes a close before overlapping input so closed children cannot restart", async () => {
    let calls = 0;
    const f = fixture(async ({ session: active, subagents }) => {
      if (active.agent.name === "Parent") {
        const child = await subagents!.create({ name: "Worker" });
        const closing = subagents!.close({ threadId: child.threadId });
        const sending = subagents!.send({ threadId: child.threadId, message: "Too late" });
        const [closed, sent] = await Promise.allSettled([closing, sending]);
        expect(closed).toMatchObject({ status: "fulfilled", value: { status: "closed" } });
        expect(sent.status).toBe("rejected");
      } else calls += 1;
    });
    await f.run();
    expect(calls).toBe(0);
  });

  it("retains a concurrency slot until the child terminal write commits", async () => {
    let terminalStarted!: () => void;
    const terminalPending = new Promise<void>((resolve) => { terminalStarted = resolve; });
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => { commit = resolve; });
    let held = false;
    const f = fixture(async ({ session: active, subagents }) => {
      if (active.agent.name === "Parent") {
        await subagents!.create({ name: "Worker", message: "Work" });
        await terminalPending;
        const attempted = subagents!.create({ name: "Excess", message: "Work" });
        setTimeout(commit, 0);
        await expect(attempted).rejects.toThrow(/concurren/i);
      }
    }, new MemorySessionThreadStore(), {
      maxConcurrentSubagents: 1,
      output: async (frame) => {
        if (frame.type === "session.thread_status_idle" && !held) {
          held = true;
          terminalStarted();
          await mayCommit;
        }
      },
    });
    await f.run();
  });
});
