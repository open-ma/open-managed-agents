import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

const temporaryDirectories: string[] = [];

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) return value + decoder.decode();
    value += decoder.decode(item.value, { stream: true });
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
});

describe("LocalSubprocessSandbox duplex process", () => {
  it("projects logical workspace paths in process env onto the local workdir", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-sandbox-env-path-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const child = await sandbox.spawnDuplexProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.AGENT_STATE ?? '')"],
      env: {
        AGENT_STATE: "/workspace/.openma/harness-state/native",
        REMOTE_URL: "https://example.com/workspace/value",
      },
    });

    await expect(readAll(child.stdout)).resolves.toBe(
      join(workdir, ".openma/harness-state/native"),
    );
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("carries multiple ACP-style stdin frames and exposes both output streams", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-sandbox-duplex-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });

    const child = await sandbox.spawnDuplexProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', chunk => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(`${process.env.OMA_TEST_MARKER}:${input}`);",
          "  process.stderr.write('diagnostic');",
          "});",
        ].join("\n"),
      ],
      env: { OMA_TEST_MARKER: "sandbox" },
      cwd: "/workspace",
    });
    const stdout = readAll(child.stdout);
    const stderr = readAll(child.stderr);
    const writer = child.stdin.getWriter();

    await writer.write(new TextEncoder().encode('{"id":1}\n'));
    await writer.write(new TextEncoder().encode('{"id":2}\n'));
    await writer.close();

    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await expect(stdout).resolves.toBe(
      'sandbox:{"id":1}\n{"id":2}\n',
    );
    await expect(stderr).resolves.toBe("diagnostic");
  });

  it("kills every live duplex child before destroying the sandbox", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "oma-sandbox-duplex-destroy-"));
    temporaryDirectories.push(workdir);
    const sandbox = new LocalSubprocessSandbox({ workdir });
    const child = await sandbox.spawnDuplexProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: "/workspace",
    });

    try {
      await sandbox.destroy();
      const exit = await Promise.race([
        child.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 150)
        ),
      ]);
      expect(exit).not.toBe("timeout");
    } finally {
      await child.kill("SIGKILL").catch(() => undefined);
    }
  });
});
