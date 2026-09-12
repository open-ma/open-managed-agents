import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { DockerCliPort } from "../src/docker";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function childProcess(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  return child;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result + decoder.decode();
      result += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("DockerCliPort", () => {
  it("captures stdout, stderr, and a non-zero exit code", async () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const running = new DockerCliPort("docker-custom").run(["version"]);
    child.stdout.write("stdout-value");
    child.stderr.write("stderr-value");
    child.emit("close", 7, null);

    await expect(running).resolves.toEqual({
      stdout: "stdout-value",
      stderr: "stderr-value",
      exitCode: 7,
    });
    expect(spawn).toHaveBeenCalledWith("docker-custom", ["version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("normalizes a null process exit code", async () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const running = new DockerCliPort().run([]);
    child.emit("close", null, "SIGTERM");
    await expect(running).resolves.toMatchObject({ exitCode: 1 });
  });

  it("rejects an already-cancelled command with the caller's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel before spawn");
    controller.abort(reason);
    await expect(new DockerCliPort().run([], { signal: controller.signal })).rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("terminates an active command and preserves the cancellation reason", async () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const controller = new AbortController();
    const reason = new Error("cancel active command");
    const running = new DockerCliPort().run([], { signal: controller.signal });
    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("propagates process spawn failures, preferring an active abort reason", async () => {
    const first = childProcess();
    vi.mocked(spawn).mockReturnValueOnce(first as never);
    const failure = new Error("spawn failure");
    const failed = new DockerCliPort().run([]);
    first.emit("error", failure);
    await expect(failed).rejects.toBe(failure);

    const second = childProcess();
    vi.mocked(spawn).mockReturnValueOnce(second as never);
    const controller = new AbortController();
    const reason = new Error("abort won");
    const aborted = new DockerCliPort().run([], { signal: controller.signal });
    controller.abort(reason);
    second.emit("error", failure);
    await expect(aborted).rejects.toBe(reason);
  });

  it("bridges duplex stdin/stdout/stderr and observes clean exit", async () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    child.stdin.on("data", (chunk) => {
      child.stdout.write(chunk);
      child.stderr.write(chunk);
    });
    child.stdin.on("end", () => {
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      child.emit("close", 0, null);
    });

    const process = new DockerCliPort().spawnDuplex(["exec", "runtime"]);
    const stdout = readStream(process.stdout);
    const stderr = readStream(process.stderr);
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode("hello duplex"));
    await writer.close();
    writer.releaseLock();

    await expect(stdout).resolves.toBe("hello duplex");
    await expect(stderr).resolves.toBe("hello duplex");
    await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(process.kill()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("supports default and explicit termination signals for duplex processes", async () => {
    const gracefulChild = childProcess();
    const forcedChild = childProcess();
    vi.mocked(spawn)
      .mockReturnValueOnce(gracefulChild as never)
      .mockReturnValueOnce(forcedChild as never);
    const port = new DockerCliPort();
    const graceful = port.spawnDuplex([]);
    await graceful.kill();
    await expect(graceful.exited).resolves.toMatchObject({ signal: "SIGTERM" });

    const forced = port.spawnDuplex([]);
    await forced.kill("SIGKILL");
    await expect(forced.exited).resolves.toMatchObject({ signal: "SIGKILL" });
  });

  it("reports duplex process spawn failures", async () => {
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(child as never);
    const process = new DockerCliPort().spawnDuplex([]);
    const failure = new Error("spawn failure");
    child.emit("error", failure);
    await expect(process.exited).rejects.toBe(failure);
  });
});
