import { mkdtemp, rm } from "node:fs/promises";

import type {
  ManagedSandboxLease,
  RuntimeResourceFence,
  RuntimeResourceScope,
  WorkspaceBinding,
} from "@open-managed-agents/runtime-resource-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBoxLiteManagedRuntime } from "../src/boxlite";

const certify = process.env.BOXLITE_CERTIFY === "1";
const suite = certify ? describe : describe.skip;

suite("BoxLite managed runtime certification", () => {
  let homeDir = "";

  beforeAll(async () => {
    // BoxLite nests several socket directories below homeDir. Keep this root
    // short enough for macOS' AF_UNIX SUN_LEN limit.
    homeDir = await mkdtemp("/tmp/oma-bl-");
  });

  afterAll(async () => {
    if (homeDir !== "") await rm(homeDir, { recursive: true, force: true });
  });

  it("retains the workspace across stop/start and removes the owned box", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const scope: RuntimeResourceScope = {
      workspaceId: `workspace-${suffix}`,
      environmentId: `environment-${suffix}`,
      sessionId: `session-${suffix}`,
      workId: `work-${suffix}`,
    };
    const firstFence: RuntimeResourceFence = {
      ...scope,
      ownerId: `owner-${suffix}`,
      generation: 1,
      token: `fence-${suffix}-1`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const signal = new AbortController().signal;
    const { JsBoxlite } = await import("@boxlite-ai/boxlite");
    const client = new JsBoxlite({ homeDir });
    const runtime = createBoxLiteManagedRuntime({
      providerId: "litebox",
      client,
      image: process.env.BOXLITE_CERTIFY_IMAGE ?? "alpine:3.20",
      cpus: 1,
      memoryMib: 512,
      leaseTtlMs: 90_000,
      outputStore: null,
      allocationOptions: () => ({ network: { mode: "disabled" } }),
    });
    let lease: ManagedSandboxLease | undefined;
    let firstWorkspace: WorkspaceBinding | undefined;
    let secondWorkspace: WorkspaceBinding | undefined;
    let releaseFence = firstFence;

    try {
      firstWorkspace = await runtime.workspace.materialize({
        scope,
        fence: firstFence,
        strategy: "retained_runtime",
        activeCheckpoint: null,
        idempotencyKey: `materialize-${suffix}-1`,
        signal,
      });
      lease = await runtime.sandbox.acquire({
        scope,
        fence: firstFence,
        plan: {
          workspaceStrategy: "retained_runtime",
          outputStrategy: null,
          runtimeCheckpoint: null,
          driver: {
            type: "ama_worker",
            process: {
              command: "/bin/sh",
              args: ["-lc", "printf retained > /workspace/openma-certification.txt"],
            },
          },
        },
        workspace: firstWorkspace,
        outputs: null,
        signal,
      });
      await expect(runtime.harness.run({
        scope,
        fence: firstFence,
        sandbox: lease,
        workspacePath: "/workspace",
        outputPath: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "/bin/sh",
            args: ["-lc", "printf retained > /workspace/openma-certification.txt"],
          },
        },
        signal,
      })).resolves.toEqual({ type: "completed" });

      const suspended = await runtime.sandbox.suspend({
        scope,
        fence: firstFence,
        lease,
        signal,
      });
      const candidate = await runtime.workspace.checkpoint({
        scope,
        fence: firstFence,
        strategy: "retained_runtime",
        binding: firstWorkspace,
        sandbox: suspended,
        idempotencyKey: `checkpoint-${suffix}`,
        signal,
      });
      const secondFence: RuntimeResourceFence = {
        ...firstFence,
        generation: 2,
        token: `fence-${suffix}-2`,
      };
      releaseFence = secondFence;
      secondWorkspace = await runtime.workspace.materialize({
        scope,
        fence: secondFence,
        strategy: "retained_runtime",
        activeCheckpoint: candidate,
        idempotencyKey: `materialize-${suffix}-2`,
        signal,
      });
      lease = await runtime.sandbox.acquire({
        scope,
        fence: secondFence,
        plan: {
          workspaceStrategy: "retained_runtime",
          outputStrategy: null,
          runtimeCheckpoint: null,
          driver: {
            type: "ama_worker",
            process: {
              command: "/bin/sh",
              args: ["-lc", "test \"$(cat /workspace/openma-certification.txt)\" = retained"],
            },
          },
        },
        workspace: secondWorkspace,
        outputs: null,
        signal,
      });
      await expect(runtime.harness.run({
        scope,
        fence: secondFence,
        sandbox: lease,
        workspacePath: "/workspace",
        outputPath: null,
        driver: {
          type: "ama_worker",
          process: {
            command: "/bin/sh",
            args: ["-lc", "test \"$(cat /workspace/openma-certification.txt)\" = retained"],
          },
        },
        signal,
      })).resolves.toEqual({ type: "completed" });

      await runtime.sandbox.terminate({
        scope,
        fence: secondFence,
        lease,
        reason: "completed",
      });
      await expect(runtime.sandbox.inspect(lease)).resolves.toEqual({ state: "unknown" });
      await expect(client.get(lease.runtimeId)).resolves.toBeNull();
      lease = undefined;
    } finally {
      if (lease !== undefined) {
        await runtime.sandbox.reap({ scope, lease, reason: "failed" }).catch(() => {});
      }
      if (secondWorkspace !== undefined) {
        await runtime.workspace.release({
          scope,
          fence: releaseFence,
          binding: secondWorkspace,
        }).catch(() => {});
      }
      if (firstWorkspace !== undefined) {
        await runtime.workspace.release({
          scope,
          fence: firstFence,
          binding: firstWorkspace,
        }).catch(() => {});
      }
      client.close();
    }
  }, 180_000);
});
