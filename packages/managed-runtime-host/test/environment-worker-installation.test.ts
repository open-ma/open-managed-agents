import { describe, expect, it, vi } from "vitest";

import {
  createManagedEnvironmentWorkerInstallation,
  type ManagedEnvironmentWorker,
} from "../src/index";

const worker: ManagedEnvironmentWorker = {
  handleWebhook: vi.fn(() => ({ type: "ignored" as const, eventId: "event_01" })),
  drain: vi.fn(async () => undefined),
  run: vi.fn(async () => undefined),
};

describe("Managed Environment Worker installation composition", () => {
  it("lazily loads only the selected provider-dispatch package", async () => {
    const dispatch = {
      descriptor: () => ({
        provider: "cloudflare",
        version: "1.0.0",
        strategy: "poll_unacked_then_dispatch" as const,
      }),
      dispatch: vi.fn(async () => undefined),
    };
    const importModule = vi.fn(async () => ({
      createManagedEnvironmentWorkDispatchPort: () => dispatch,
    }));
    const createDispatchedWorker = vi.fn(() => worker);

    const installation = await createManagedEnvironmentWorkerInstallation({
      mode: "provider_dispatch",
      adapter: {
        provider: "cloudflare",
        moduleSpecifier: "@open-managed-agents/environment-dispatch-cloudflare",
        factoryOptions: { binding: "SANDBOX" },
        importModule,
      },
      worker: { client: {} as never, environmentId: "env_01", environmentKey: "key", workspaceId: "ws_01" },
    }, { createDispatchedWorker });

    expect(importModule).toHaveBeenCalledOnce();
    expect(createDispatchedWorker).toHaveBeenCalledWith(expect.objectContaining({ dispatch }));
    expect(installation).toEqual({
      mode: "provider_dispatch",
      strategy: "poll_unacked_then_dispatch",
      environmentWorker: worker,
    });
  });

  it("lazily loads provider-native activation without importing a runtime driver", async () => {
    const activation = {
      descriptor: () => ({
        provider: "aws-microvm",
        version: "1.0.0",
        strategy: "acquire_then_session_poll" as const,
      }),
      activate: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
    };
    const importModule = vi.fn(async () => ({
      createManagedEnvironmentActivationPort: () => activation,
    }));
    const createProviderNativeWorker = vi.fn(() => worker);

    const installation = await createManagedEnvironmentWorkerInstallation({
      mode: "provider_activation",
      adapter: {
        provider: "aws-microvm",
        moduleSpecifier: "@open-managed-agents/environment-activation-aws",
        factoryOptions: { launcher: "lambda" },
        importModule,
      },
      worker: { client: {} as never, environmentId: "env_01", workspaceId: "ws_01" },
    }, { createProviderNativeWorker });

    expect(importModule).toHaveBeenCalledOnce();
    expect(createProviderNativeWorker).toHaveBeenCalledWith(expect.objectContaining({ activation }));
    expect(installation).toEqual({
      mode: "provider_activation",
      strategy: "acquire_then_session_poll",
      environmentWorker: worker,
    });
  });

  it("keeps runtime-host and external Worker paths dependency-free", async () => {
    const createRuntimeHostWorker = vi.fn(() => worker);
    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "runtime_host",
      worker: {} as never,
    }, { createRuntimeHostWorker })).resolves.toEqual({
      mode: "runtime_host",
      strategy: "claim_then_acquire",
      environmentWorker: worker,
    });
    expect(createRuntimeHostWorker).toHaveBeenCalledOnce();

    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "external_worker",
    })).resolves.toEqual({
      mode: "external_worker",
      strategy: "external_worker",
      environmentWorker: null,
    });
  });

  it("loads a selected runtime driver and projects it into the common host state machine", async () => {
    const factoryOptions = { endpoint: "https://sandbox.acme.test" };
    const factory = vi.fn(() => ({
      descriptor: () => ({
        provider: "acme",
        version: "1.0.0",
        placements: ["driver_service" as const],
        capabilities: {
          sandbox: {
            suspendResume: "unsupported" as const,
            hardTerminate: "supported" as const,
            runtimeCheckpoints: [],
          },
          workspace: { strategies: ["ephemeral" as const] },
          outputs: { strategies: [] },
          harness: { drivers: ["ama_worker" as const] },
        },
        credentialEgress: {
          enforcement: "unsupported" as const,
          credentialMode: "snapshot" as const,
          interceptedProtocols: [],
        },
      }),
      create: vi.fn(),
    }));
    const createRuntimeHostWorker = vi.fn(() => worker);

    const installation = await createManagedEnvironmentWorkerInstallation({
      mode: "runtime_host",
      adapter: {
        provider: "acme",
        moduleSpecifier: "@open-managed-agents/managed-runtime-acme",
        factoryOptions,
        importModule: vi.fn(async () => ({
          createManagedRuntimeProviderDriver: factory,
        })),
      },
      runtime: {
        placement: "driver_service",
        providerConfig: { pool: "warm" },
        ownerId: "worker_01",
        leaseTtlMs: 90_000,
        heartbeatIntervalMs: 30_000,
        fences: {} as never,
        orphans: {} as never,
      },
      worker: {
        client: {} as never,
        environmentId: "env_01",
        environmentKey: "key",
        workspaceId: "ws_01",
        profileFor: vi.fn(),
      },
    } as never, { createRuntimeHostWorker });

    expect(factory).toHaveBeenCalledWith(factoryOptions);
    expect(createRuntimeHostWorker).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env_01",
      host: expect.objectContaining({ run: expect.any(Function) }),
    }));
    expect(installation).toEqual({
      mode: "runtime_host",
      strategy: "claim_then_acquire",
      environmentWorker: worker,
    });
  });

  it("constructs every embedded mode with the built-in worker factories", async () => {
    const client = {
      baseURL: "https://api.example.test",
      beta: { webhooks: { unwrap: vi.fn() }, environments: { work: { poller: vi.fn() } } },
      withOptions: vi.fn(() => ({ beta: { environments: { work: {} }, sessions: {}, files: {} } })),
    };
    const runtimeWorker = {
      client: client as never,
      environmentId: "env_01",
      environmentKey: "key",
      workspaceId: "ws_01",
      host: {} as never,
      profileFor: vi.fn(),
    };
    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "runtime_host",
      worker: runtimeWorker,
    })).resolves.toMatchObject({
      mode: "runtime_host",
      environmentWorker: expect.objectContaining({ run: expect.any(Function) }),
    });

    const dispatch = {
      descriptor: () => ({ provider: "dispatch", version: "1", strategy: "poll_unacked_then_dispatch" as const }),
      dispatch: vi.fn(),
    };
    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "provider_dispatch",
      adapter: {
        provider: "dispatch",
        moduleSpecifier: "dispatch-module",
        factoryOptions: {},
        importModule: async () => ({ createManagedEnvironmentWorkDispatchPort: () => dispatch }),
      },
      worker: { client: client as never, environmentId: "env_01", environmentKey: "key", workspaceId: "ws_01" },
    })).resolves.toMatchObject({
      mode: "provider_dispatch",
      environmentWorker: expect.objectContaining({ run: expect.any(Function) }),
    });

    const activation = {
      descriptor: () => ({ provider: "activation", version: "1", strategy: "acquire_then_session_poll" as const }),
      activate: vi.fn(),
      reconcile: vi.fn(),
    };
    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "provider_activation",
      adapter: {
        provider: "activation",
        moduleSpecifier: "activation-module",
        factoryOptions: {},
        importModule: async () => ({ createManagedEnvironmentActivationPort: () => activation }),
      },
      worker: { client: {} as never, environmentId: "env_01", workspaceId: "ws_01" },
    })).resolves.toMatchObject({
      mode: "provider_activation",
      environmentWorker: expect.objectContaining({ run: expect.any(Function) }),
    });

    const providerDriver = {
      descriptor: () => ({
        provider: "runtime",
        version: "1",
        placements: ["driver_service" as const],
        capabilities: {
          sandbox: { suspendResume: "unsupported" as const, hardTerminate: "supported" as const, runtimeCheckpoints: [] },
          workspace: { strategies: ["ephemeral" as const] },
          outputs: { strategies: [] },
          harness: { drivers: ["ama_worker" as const] },
        },
        credentialEgress: { enforcement: "unsupported" as const, credentialMode: "snapshot" as const, interceptedProtocols: [] },
      }),
      create: vi.fn(),
    };
    await expect(createManagedEnvironmentWorkerInstallation({
      mode: "runtime_host",
      adapter: {
        provider: "runtime",
        moduleSpecifier: "runtime-module",
        factoryOptions: {},
        importModule: async () => ({ createManagedRuntimeProviderDriver: () => providerDriver }),
      },
      runtime: {
        placement: "driver_service",
        providerConfig: {},
        ownerId: "worker",
        leaseTtlMs: 90_000,
        heartbeatIntervalMs: 30_000,
        fences: {} as never,
        orphans: {} as never,
      },
      worker: {
        client: client as never,
        environmentId: "env_01",
        environmentKey: "key",
        workspaceId: "ws_01",
        profileFor: vi.fn(),
      },
    })).resolves.toMatchObject({
      mode: "runtime_host",
      environmentWorker: expect.objectContaining({ run: expect.any(Function) }),
    });
  });
});
