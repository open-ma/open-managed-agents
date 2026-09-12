import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";

import { NodeManagedSessionOutputCollector } from "../src/lib/node-managed-session-outputs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openma-node-outputs-"));
  roots.push(root);
  return root;
}

function encodedPaths(...paths: string[]): string {
  return Buffer.from(`${paths.join("\0")}${paths.length === 0 ? "" : "\0"}`)
    .toString("base64");
}

describe("NodeManagedSessionOutputCollector", () => {
  it("promotes a best-effort provider directory into the durable host output root", async () => {
    const root = await outputRoot();
    const files = new Map([
      ["/mnt/session/outputs/report.txt", new TextEncoder().encode("REPORT_OK")],
      ["/mnt/session/outputs/nested/data.bin", new Uint8Array([0, 1, 255])],
    ]);
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "best_effort" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
      exec: vi.fn(async () => encodedPaths(...files.keys())),
      readFileBytes: vi.fn(async (path: string) => files.get(path)!),
    } as unknown as SandboxExecutor;
    const isFenceActive = vi.fn(async () => true);
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: root,
      isFenceActive,
    });

    await collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox,
      executionFence: { generation: 7 } as never,
    });

    await expect(readFile(join(root, "workspace_1", "session_1", "report.txt"), "utf8"))
      .resolves.toBe("REPORT_OK");
    await expect(readFile(join(root, "workspace_1", "session_1", "nested/data.bin")))
      .resolves.toEqual(Buffer.from([0, 1, 255]));
    expect(isFenceActive).toHaveBeenCalledTimes(2);
  });

  it("does not collect provider-native durable mounts", async () => {
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: await outputRoot(),
      isFenceActive: async () => true,
    });
    const exec = vi.fn(async () => "");

    await collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox: {
        sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
        mountSessionOutputs: async () => undefined,
        exec,
      } as unknown as SandboxExecutor,
      executionFence: { generation: 1 } as never,
    });

    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps the previous durable snapshot when the execution fence is lost", async () => {
    const root = await outputRoot();
    const target = join(root, "workspace_1", "session_1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "report.txt"), "PREVIOUS");
    const collector = new NodeManagedSessionOutputCollector({
      outputsRoot: root,
      isFenceActive: async () => false,
    });

    await expect(collector.synchronize({
      workspaceId: "workspace_1",
      sessionId: "session_1",
      sandbox: {
        sessionOutputMountCapabilities: () => ({ durability: "best_effort" as const }),
        mountSessionOutputs: async () => undefined,
        exec: async () => encodedPaths("/mnt/session/outputs/report.txt"),
        readFileBytes: async () => new TextEncoder().encode("STALE"),
      } as unknown as SandboxExecutor,
      executionFence: { generation: 2 } as never,
    })).rejects.toThrow(/execution fence/i);

    await expect(readFile(join(target, "report.txt"), "utf8"))
      .resolves.toBe("PREVIOUS");
  });
});
