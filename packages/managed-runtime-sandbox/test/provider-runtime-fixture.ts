import { vi } from "vitest";
import type {
  ManagedRuntimePlan,
  RuntimeResourceFence,
  RuntimeResourceScope,
  WorkspaceStrategy,
} from "@open-managed-agents/runtime-resource-contract";
import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxPort,
  SandboxRuntimePort,
} from "@open-managed-agents/sandbox";

import {
  createProviderManagedRuntime,
  type ProviderManagedRuntimeComposition,
  type ProviderManagedRuntimeOptions,
  type ProviderManagedRuntimeProviderPort,
} from "../src/index";

export const scope: RuntimeResourceScope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

export const fence: RuntimeResourceFence = {
  ...scope,
  ownerId: "owner_1",
  generation: 1,
  token: "fence-secret",
  expiresAt: "2026-09-03T12:00:00.000Z",
};

export type TestRuntime = SandboxPort & SandboxRuntimePort & {
  spawnDuplexProcess?: (spec: {
    command: string;
    args?: string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
  }) => Promise<SandboxDuplexProcess>;
};

export function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export function process(
  overrides: Partial<SandboxDuplexProcess> = {},
): SandboxDuplexProcess {
  return {
    stdin: new WritableStream(),
    stdout: stream(),
    stderr: stream(),
    kill: vi.fn(async () => {}),
    exited: Promise.resolve({ code: 0, signal: null }),
    ...overrides,
  };
}

export function runtime(
  id = "runtime_1",
  overrides: Partial<TestRuntime> = {},
): TestRuntime {
  const base: TestRuntime = {
    runtimeHandle: () => ({ provider: "e2b", runtimeId: id }),
    runtimeCapabilities: () => ({
      lease: true,
      suspend: ["memory"],
      checkpoint: ["memory"],
    }),
    status: vi.fn(async () => "running" as const),
    renewLease: vi.fn(async () => {}),
    suspend: vi.fn(async () => ({
      provider: "e2b",
      checkpointId: `suspend-${id}`,
      sourceRuntimeId: id,
      kind: "memory",
      scope: "runtime",
    } satisfies SandboxCheckpointHandle)),
    resume: vi.fn(async () => {}),
    checkpoint: vi.fn(async () => ({
      provider: "e2b",
      checkpointId: `checkpoint-${id}`,
      sourceRuntimeId: id,
      kind: "memory",
      scope: "portable",
    } satisfies SandboxCheckpointHandle)),
    exec: vi.fn(async (command: string) =>
      command.includes("__OPENMA_RUNTIME_READY__")
        ? "__OPENMA_RUNTIME_READY__"
        : ""
    ),
    readFile: vi.fn(async () => ""),
    readFileBytes: vi.fn(async () => new Uint8Array()),
    writeFile: vi.fn(async (path: string) => path),
    writeFileBytes: vi.fn(async (path: string) => path),
    gitCheckout: vi.fn(async () => undefined),
    destroy: vi.fn(async () => {}),
    spawnDuplexProcess: vi.fn(async () => process()),
  };
  return Object.assign(base, overrides);
}

export function provider(
  created: TestRuntime = runtime(),
): ProviderManagedRuntimeProviderPort<TestRuntime> {
  return {
    create: vi.fn(async () => created),
    resume: vi.fn(async () => created),
    restore: vi.fn(async () => created),
  };
}

export function composition(
  selectedProvider: ProviderManagedRuntimeProviderPort<TestRuntime> = provider(),
  overrides: Partial<ProviderManagedRuntimeOptions<TestRuntime>> = {},
): ProviderManagedRuntimeComposition {
  return createProviderManagedRuntime({
    providerName: "e2b",
    provider: selectedProvider,
    context: (inputScope) => ({
      sessionId: inputScope.sessionId,
      workdir: `/tmp/${inputScope.workId}`,
    }),
    environment: () => ({}),
    leaseTtlMs: 90_000,
    sandboxCapabilities: {
      suspendResume: "supported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["retained_runtime", "checkpoint_restore", "ephemeral"],
      retainedSuspendKind: "memory",
      portableCheckpointKind: "memory",
    },
    drivers: ["ama_worker"],
    ...overrides,
  });
}

export const plan: ManagedRuntimePlan = {
  workspaceStrategy: "retained_runtime",
  outputStrategy: null,
  runtimeCheckpoint: null,
  driver: { type: "ama_worker", process: { command: "worker" } },
};

export async function binding(
  composed: ProviderManagedRuntimeComposition,
  strategy: WorkspaceStrategy = "retained_runtime",
) {
  return composed.workspace.materialize({
    scope,
    fence,
    strategy,
    activeCheckpoint: null,
    idempotencyKey: `materialize-${strategy}`,
    signal: new AbortController().signal,
  });
}

export async function acquire(
  composed: ProviderManagedRuntimeComposition,
  options: {
    strategy?: WorkspaceStrategy;
    signal?: AbortSignal;
  } = {},
) {
  const workspace = await binding(composed, options.strategy);
  return composed.sandbox.acquire({
    scope,
    fence,
    plan: { ...plan, workspaceStrategy: options.strategy ?? "retained_runtime" },
    workspace,
    outputs: null,
    signal: options.signal ?? new AbortController().signal,
  });
}
