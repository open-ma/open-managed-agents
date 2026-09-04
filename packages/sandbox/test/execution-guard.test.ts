import { describe, expect, it, vi } from "vitest";
import { withSandboxExecutionGuard, SandboxExecutionFencedError } from "../src/execution-guard";
import type { SandboxPort, ProcessHandle } from "../src/ports";

function sandboxFixture() {
  const process: ProcessHandle = {
    id: "proc-1",
    pid: 42,
    kill: vi.fn(async () => undefined),
    getLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
    getStatus: vi.fn(async () => "running"),
  };
  const sandbox: SandboxPort = {
    exec: vi.fn(async () => "exit=0\nok"),
    startProcess: vi.fn(async () => process),
    readFile: vi.fn(async () => "data"),
    writeFile: vi.fn(async () => "ok"),
    registerCommandSecrets: vi.fn(),
  };
  return { sandbox, process };
}

describe("withSandboxExecutionGuard", () => {
  it("rejects all remote calls once the parent execution is aborted", async () => {
    const { sandbox } = sandboxFixture();
    const controller = new AbortController();
    const guarded = withSandboxExecutionGuard(sandbox, { signal: controller.signal });

    controller.abort(new Error("lease lost"));

    await expect(guarded.exec("echo stale")).rejects.toBeInstanceOf(SandboxExecutionFencedError);
    await expect(guarded.readFile("/workspace/stale")).rejects.toBeInstanceOf(SandboxExecutionFencedError);
    await expect(guarded.writeFile("/workspace/stale", "x")).rejects.toBeInstanceOf(SandboxExecutionFencedError);
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("checks expiry before and after a call, preventing a stale result from being used", async () => {
    const { sandbox } = sandboxFixture();
    let valid = true;
    const guarded = withSandboxExecutionGuard(sandbox, {
      isValid: () => valid,
    });

    valid = false;
    await expect(guarded.exec("echo stale")).rejects.toMatchObject({
      name: "SandboxExecutionFencedError",
    });

    valid = true;
    const pending = new Promise<string>((resolve) => setTimeout(() => {
      valid = false;
      resolve("exit=0\nlate");
    }, 1));
    sandbox.exec = vi.fn(() => pending);
    await expect(guarded.exec("echo late")).rejects.toBeInstanceOf(SandboxExecutionFencedError);
  });

  it("kills a process handle when the parent fence is revoked", async () => {
    const { sandbox, process } = sandboxFixture();
    const controller = new AbortController();
    const guarded = withSandboxExecutionGuard(sandbox, { signal: controller.signal });

    await expect(guarded.startProcess!("sleep 100")).resolves.toBe(process);
    controller.abort(new Error("interrupt"));
    await Promise.resolve();
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not guard local registration helpers", () => {
    const { sandbox } = sandboxFixture();
    const controller = new AbortController();
    const guarded = withSandboxExecutionGuard(sandbox, { signal: controller.signal });
    controller.abort();
    expect(() => guarded.registerCommandSecrets!("git", { TOKEN: "secret" })).not.toThrow();
    expect(sandbox.registerCommandSecrets).toHaveBeenCalledWith("git", { TOKEN: "secret" });
  });
});
