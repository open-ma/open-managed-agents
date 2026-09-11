import {
  createDispatchedManagedEnvironmentWorker,
  type DispatchedManagedEnvironmentWorkerOptions,
} from "./dispatched-environment-worker";
import { loadManagedEnvironmentActivationPort } from "./environment-activation-loader";
import { loadManagedEnvironmentWorkDispatchPort } from "./environment-dispatch-loader";
import {
  createManagedEnvironmentWorker,
  type ManagedEnvironmentWorker,
  type ManagedEnvironmentWorkerOptions,
} from "./environment-worker";
import { loadManagedRuntimeProviderDriver } from "./provider-driver-loader";
import {
  createManagedRuntimeProviderHost,
  type ManagedRuntimeProviderHostOptions,
} from "./provider-driver-host";
import {
  createProviderNativeManagedEnvironmentWorker,
  type ProviderNativeManagedEnvironmentWorkerOptions,
} from "./provider-native-environment-worker";

export interface LazyProviderModule<FactoryOptions = unknown> {
  provider: string;
  moduleSpecifier: string;
  factoryOptions: FactoryOptions;
  importModule?(specifier: string): Promise<unknown>;
}

export type ManagedEnvironmentWorkerInstallationInput =
  | {
      mode: "runtime_host";
      worker: ManagedEnvironmentWorkerOptions;
    }
  | {
      mode: "runtime_host";
      adapter: LazyProviderModule;
      runtime: Omit<ManagedRuntimeProviderHostOptions, "driver">;
      worker: Omit<ManagedEnvironmentWorkerOptions, "host">;
    }
  | {
      mode: "provider_dispatch";
      adapter: LazyProviderModule;
      worker: Omit<DispatchedManagedEnvironmentWorkerOptions, "dispatch">;
    }
  | {
      mode: "provider_activation";
      adapter: LazyProviderModule;
      worker: Omit<ProviderNativeManagedEnvironmentWorkerOptions, "activation">;
    }
  | {
      /** BYOW compatibility boundary. OpenMA serves the official Work API but
       * deliberately starts no local scheduler or provider runtime. */
      mode: "external_worker";
    };

export type ManagedEnvironmentWorkerInstallation =
  | {
      mode: "runtime_host";
      strategy: "claim_then_acquire";
      environmentWorker: ManagedEnvironmentWorker;
    }
  | {
      mode: "provider_dispatch";
      strategy: "poll_unacked_then_dispatch";
      environmentWorker: ManagedEnvironmentWorker;
    }
  | {
      mode: "provider_activation";
      strategy: "acquire_then_session_poll";
      environmentWorker: ManagedEnvironmentWorker;
    }
  | {
      mode: "external_worker";
      strategy: "external_worker";
      environmentWorker: null;
    };

export interface ManagedEnvironmentWorkerInstallationDependencies {
  createRuntimeHostWorker?: typeof createManagedEnvironmentWorker;
  createDispatchedWorker?: typeof createDispatchedManagedEnvironmentWorker;
  createProviderNativeWorker?: typeof createProviderNativeManagedEnvironmentWorker;
}

/** One configuration switch for the three maintained embedded lifecycle
 * strategies and the protocol-only external Worker boundary. Provider modules
 * are dynamically imported only after their mode is selected. */
export function createManagedEnvironmentWorkerInstallation(
  input: Extract<ManagedEnvironmentWorkerInstallationInput, { mode: "runtime_host" }>,
  dependencies?: ManagedEnvironmentWorkerInstallationDependencies,
): Promise<Extract<ManagedEnvironmentWorkerInstallation, { mode: "runtime_host" }>>;
export function createManagedEnvironmentWorkerInstallation(
  input: Extract<ManagedEnvironmentWorkerInstallationInput, { mode: "provider_dispatch" }>,
  dependencies?: ManagedEnvironmentWorkerInstallationDependencies,
): Promise<Extract<ManagedEnvironmentWorkerInstallation, { mode: "provider_dispatch" }>>;
export function createManagedEnvironmentWorkerInstallation(
  input: Extract<ManagedEnvironmentWorkerInstallationInput, { mode: "provider_activation" }>,
  dependencies?: ManagedEnvironmentWorkerInstallationDependencies,
): Promise<Extract<ManagedEnvironmentWorkerInstallation, { mode: "provider_activation" }>>;
export function createManagedEnvironmentWorkerInstallation(
  input: Extract<ManagedEnvironmentWorkerInstallationInput, { mode: "external_worker" }>,
  dependencies?: ManagedEnvironmentWorkerInstallationDependencies,
): Promise<Extract<ManagedEnvironmentWorkerInstallation, { mode: "external_worker" }>>;
export async function createManagedEnvironmentWorkerInstallation(
  input: ManagedEnvironmentWorkerInstallationInput,
  dependencies: ManagedEnvironmentWorkerInstallationDependencies = {},
): Promise<ManagedEnvironmentWorkerInstallation> {
  switch (input.mode) {
    case "runtime_host": {
      if ("adapter" in input) {
        const driver = await loadManagedRuntimeProviderDriver(input.adapter);
        const host = createManagedRuntimeProviderHost({
          ...input.runtime,
          driver,
        });
        return {
          mode: input.mode,
          strategy: "claim_then_acquire",
          environmentWorker: (dependencies.createRuntimeHostWorker
            ?? createManagedEnvironmentWorker)({
            ...input.worker,
            host,
          }),
        };
      }
      return {
        mode: input.mode,
        strategy: "claim_then_acquire",
        environmentWorker: (dependencies.createRuntimeHostWorker
          ?? createManagedEnvironmentWorker)(input.worker),
      };
    }

    case "provider_dispatch": {
      const dispatch = await loadManagedEnvironmentWorkDispatchPort({
        ...input.adapter,
      });
      return {
        mode: input.mode,
        strategy: "poll_unacked_then_dispatch",
        environmentWorker: (dependencies.createDispatchedWorker
          ?? createDispatchedManagedEnvironmentWorker)({
          ...input.worker,
          dispatch,
        }),
      };
    }

    case "provider_activation": {
      const activation = await loadManagedEnvironmentActivationPort({
        ...input.adapter,
      });
      return {
        mode: input.mode,
        strategy: "acquire_then_session_poll",
        environmentWorker: (dependencies.createProviderNativeWorker
          ?? createProviderNativeManagedEnvironmentWorker)({
          ...input.worker,
          activation,
        }),
      };
    }

    case "external_worker":
      return {
        mode: input.mode,
        strategy: "external_worker",
        environmentWorker: null,
      };
  }
}
