import { describe, expect, it, vi } from "vitest";

import * as supervisorModule from "../src/index";

const start = {
  type: "start" as const,
  scope: {
    workspaceId: "workspace_jsonl",
    environmentId: "environment_jsonl",
    sessionId: "session_jsonl",
    workId: "work_jsonl",
  },
  harness: { id: "fixture", version: "1" },
  workspacePath: "/workspace" as const,
  outputPath: "/mnt/session/outputs" as const,
};

function jsonlServer(): (options: any) => Promise<void> {
  const candidate = (supervisorModule as Record<string, unknown>)[
    "serveHarnessSupervisorJsonl"
  ];
  expect(candidate).toBeTypeOf("function");
  return candidate as (options: any) => Promise<void>;
}

async function nextLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<unknown> {
  const decoder = new TextDecoder();
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      return JSON.parse(line);
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("supervisor output ended before a JSONL event");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

function bufferedServer(inputText: string, options: {
  resolveHarness?: (harness: { id: string; version: string }) => Promise<any>;
} = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let outputBuffer = "";
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(inputText));
      controller.close();
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      outputBuffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = outputBuffer.indexOf("\n");
        if (newline < 0) break;
        events.push(JSON.parse(outputBuffer.slice(0, newline)));
        outputBuffer = outputBuffer.slice(newline + 1);
      }
    },
  });
  const serving = jsonlServer()({
    input,
    output,
    heartbeatIntervalMs: 60_000,
    resolveHarness: options.resolveHarness ?? vi.fn(async () => null),
  });
  return { serving, events };
}

describe("harness supervisor JSONL protocol", () => {
  it("accepts fragmented commands and emits ordered lifecycle events", async () => {
    let complete!: (value: { exitCode: number }) => void;
    const run = {
      completed: new Promise<{ exitCode: number }>((resolve) => {
        complete = resolve;
      }),
      drain: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    const encoder = new TextEncoder();
    const state = { buffer: "" };
    const serving = jsonlServer()({
      input: input.readable,
      output: output.writable,
      heartbeatIntervalMs: 60_000,
      scheduler: {
        sleep: async (_milliseconds: number, signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      },
      resolveHarness: vi.fn(async () => ({ start: vi.fn(async () => run) })),
    });

    const encodedStart = JSON.stringify(start) + "\n";
    await writer.write(encoder.encode(encodedStart.slice(0, 17)));
    const startWrite = writer.write(encoder.encode(encodedStart.slice(17)));
    await expect(nextLine(reader, state)).resolves.toEqual({
      type: "ready",
      protocol: "openma-harness-supervisor-v1",
    });
    await startWrite;

    complete({ exitCode: 0 });
    await expect(nextLine(reader, state)).resolves.toEqual({
      type: "completed",
      exitCode: 0,
    });
    const drainWrite = writer.write(encoder.encode(`${JSON.stringify({ type: "drain" })}\n`));
    await expect(nextLine(reader, state)).resolves.toEqual({ type: "drained" });
    await drainWrite;

    await writer.close();
    await serving;
    expect(run.drain).toHaveBeenCalledOnce();
    expect(run.stop).not.toHaveBeenCalled();
  });

  it("round-trips a checkpoint request and commit over JSONL", async () => {
    let checkpoint!: () => Promise<void>;
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    const encoder = new TextEncoder();
    const state = { buffer: "" };
    const serving = jsonlServer()({
      input: input.readable,
      output: output.writable,
      heartbeatIntervalMs: 60_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async (options) => {
          checkpoint = () => options.checkpoint({
            sessionId: start.scope.sessionId,
            turnId: "turn_jsonl",
          });
          return {
            completed: new Promise<{ exitCode: number }>(() => {}),
            drain: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        }),
      })),
    });
    await writer.write(encoder.encode(`${JSON.stringify(start)}\n`));
    await expect(nextLine(reader, state)).resolves.toMatchObject({ type: "ready" });
    const pending = checkpoint();
    await expect(nextLine(reader, state)).resolves.toEqual({
      type: "checkpoint",
      checkpointId: "checkpoint_1",
      sessionId: start.scope.sessionId,
      turnId: "turn_jsonl",
    });
    await writer.write(encoder.encode(`${JSON.stringify({
      type: "checkpoint.commit",
      checkpointId: "checkpoint_1",
    })}\n`));
    await pending;
    await writer.close();
    await serving;
  });

  it("round-trips a checkpoint rejection over JSONL", async () => {
    let checkpoint!: () => Promise<void>;
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    const encoder = new TextEncoder();
    const state = { buffer: "" };
    const serving = jsonlServer()({
      input: input.readable,
      output: output.writable,
      heartbeatIntervalMs: 60_000,
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async (options) => {
          checkpoint = () => options.checkpoint({ sessionId: start.scope.sessionId });
          return {
            completed: new Promise<{ exitCode: number }>(() => {}),
            drain: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        }),
      })),
    });
    await writer.write(encoder.encode(`${JSON.stringify(start)}\n`));
    await expect(nextLine(reader, state)).resolves.toMatchObject({ type: "ready" });
    const pending = checkpoint();
    await expect(nextLine(reader, state)).resolves.toMatchObject({
      type: "checkpoint",
      checkpointId: "checkpoint_1",
    });
    await writer.write(encoder.encode(`${JSON.stringify({
      type: "checkpoint.reject",
      checkpointId: "checkpoint_1",
      message: "workspace fence lost",
    })}\n`));
    await expect(pending).rejects.toThrow("workspace fence lost");
    await writer.close();
    await serving;
  });

  it("accepts a final command without a newline and closes a running harness", async () => {
    const stop = vi.fn(async () => {});
    const { serving, events } = bufferedServer(JSON.stringify({
      ...start,
      outputPath: null,
    }), {
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed: new Promise<never>(() => {}),
          drain: vi.fn(async () => {}),
          stop,
        })),
      })),
    });

    await serving;
    expect(events).toEqual([{
      type: "ready",
      protocol: "openma-harness-supervisor-v1",
    }]);
    expect(stop).toHaveBeenCalledWith("aborted");
  });

  it("dispatches an explicit stop command and preserves its reason", async () => {
    const stop = vi.fn(async () => {});
    const { serving, events } = bufferedServer(
      `${JSON.stringify(start)}\n${JSON.stringify({ type: "stop", reason: "failed" })}\n`,
      {
        resolveHarness: vi.fn(async () => ({
          start: vi.fn(async () => ({
            completed: new Promise<never>(() => {}),
            drain: vi.fn(async () => {}),
            stop,
          })),
        })),
      },
    );

    await serving;
    expect(events).toContainEqual({
      type: "ready",
      protocol: "openma-harness-supervisor-v1",
    });
    expect(stop).toHaveBeenCalledWith("failed");
  });

  it("does not turn a transport close failure into a completed-work failure", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const output = new WritableStream<Uint8Array>({
      close() {
        throw new Error("transport close failed");
      },
    });

    await expect(jsonlServer()({
      input,
      output,
      heartbeatIntervalMs: 60_000,
      resolveHarness: vi.fn(async () => null),
    })).resolves.toBeUndefined();
  });

  it("contains harness shutdown failure when the input stream ends", async () => {
    const { serving } = bufferedServer(JSON.stringify(start), {
      resolveHarness: vi.fn(async () => ({
        start: vi.fn(async () => ({
          completed: new Promise<never>(() => {}),
          drain: vi.fn(async () => {}),
          stop: vi.fn(async () => { throw new Error("shutdown failed"); }),
        })),
      })),
    });

    await expect(serving).resolves.toBeUndefined();
  });

  it("normalizes a non-Error input failure and contains broken cleanup transports", async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error("input stream failed");
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const output = new WritableStream<Uint8Array>({
      write() {
        throw new Error("error event write failed");
      },
    });

    await expect(jsonlServer()({
      input,
      output,
      heartbeatIntervalMs: 60_000,
      resolveHarness: vi.fn(async () => null),
    })).rejects.toBe("input stream failed");
  });

  it.each([
    ["invalid JSON", "{", /invalid JSON/],
    ["array command", "[]", /object with a type/],
    ["missing type", "{}", /object with a type/],
    ["unknown command", '{"type":"wat"}', /Unknown harness supervisor command/],
    ["bad stop reason", '{"type":"stop","reason":"done"}', /stop reason/],
    ["bad checkpoint commit", '{"type":"checkpoint.commit","checkpointId":""}', /checkpoint id/],
    ["bad checkpoint rejection id", '{"type":"checkpoint.reject","checkpointId":"","message":"failed"}', /checkpoint rejection/],
    ["bad checkpoint rejection", '{"type":"checkpoint.reject","checkpointId":"x","message":""}', /checkpoint rejection/],
    [
      "bad scope",
      JSON.stringify({ ...start, scope: { ...start.scope, workId: "" } }),
      /start scope is invalid/,
    ],
    [
      "bad harness",
      JSON.stringify({ ...start, harness: { id: "", version: "1" } }),
      /start harness is invalid/,
    ],
    [
      "bad workspace",
      JSON.stringify({ ...start, workspacePath: "/tmp" }),
      /workspacePath must be \/workspace/,
    ],
    [
      "bad output",
      JSON.stringify({ ...start, outputPath: "/tmp/output" }),
      /outputPath is invalid/,
    ],
  ])("rejects %s and emits one protocol error", async (_name, command, message) => {
    const { serving, events } = bufferedServer(`${command}\n`);
    await expect(serving).rejects.toThrow(message);
    expect(events).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
  });
});
