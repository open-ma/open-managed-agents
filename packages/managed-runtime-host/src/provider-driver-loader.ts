import type {
  ManagedRuntimeProviderDriverPort,
} from "@open-managed-agents/runtime-resource-contract";

export interface ManagedRuntimeProviderDriverModule {
  createManagedRuntimeProviderDriver(
    factoryOptions: unknown,
  ): ManagedRuntimeProviderDriverPort | Promise<ManagedRuntimeProviderDriverPort>;
}

export interface LoadManagedRuntimeProviderDriverInput {
  /** Expected provider identity from operator configuration. */
  provider: string;
  /** Installed adapter package. It is loaded only after selection. */
  moduleSpecifier: string;
  /** Adapter-owned options. The generic host never interprets provider SDK values. */
  factoryOptions: unknown;
  /** Injectable to keep resolution deterministic in tests and custom runtimes. */
  importModule?(specifier: string): Promise<unknown>;
}

/** Load exactly one installed provider package through its uniform factory
 * export. The host keeps no dependency on provider packages or their SDKs. */
export async function loadManagedRuntimeProviderDriver(
  input: LoadManagedRuntimeProviderDriverInput,
): Promise<ManagedRuntimeProviderDriverPort> {
  if (input.provider.trim() === "") throw new TypeError("Managed Runtime provider must not be empty");
  if (input.moduleSpecifier.trim() === "") {
    throw new TypeError("Managed Runtime adapter module specifier must not be empty");
  }
  const imported = await (input.importModule ?? importProviderModule)(input.moduleSpecifier);
  if (typeof imported !== "object" || imported === null) {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedRuntimeProviderDriver`,
    );
  }
  const factory = Reflect.get(imported, "createManagedRuntimeProviderDriver");
  if (typeof factory !== "function") {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedRuntimeProviderDriver`,
    );
  }
  const driver = await factory(input.factoryOptions) as ManagedRuntimeProviderDriverPort;
  if (
    typeof driver !== "object"
    || driver === null
    || typeof driver.descriptor !== "function"
    || typeof driver.create !== "function"
  ) {
    throw new TypeError(`${input.moduleSpecifier} returned an invalid Managed Runtime driver`);
  }
  const descriptor = driver.descriptor();
  if (descriptor.provider !== input.provider) {
    throw new Error(
      `Configured provider ${input.provider} loaded ${input.moduleSpecifier}, which advertised provider ${descriptor.provider}`,
    );
  }
  return driver;
}

async function importProviderModule(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}
