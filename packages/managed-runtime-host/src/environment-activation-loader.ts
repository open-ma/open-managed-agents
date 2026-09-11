import type { ManagedEnvironmentActivationPort } from "./provider-native-environment-worker";

export interface ManagedEnvironmentActivationModule {
  createManagedEnvironmentActivationPort(
    factoryOptions: unknown,
  ): ManagedEnvironmentActivationPort | Promise<ManagedEnvironmentActivationPort>;
}

export interface LoadManagedEnvironmentActivationPortInput {
  /** Expected provider identity from operator configuration. */
  provider: string;
  /** Installed adapter package; loaded only after this provider is selected. */
  moduleSpecifier: string;
  /** Adapter-owned configuration. Provider SDK objects never enter the host. */
  factoryOptions: unknown;
  importModule?(specifier: string): Promise<unknown>;
}

/** Load one provider-native activation package without adding its SDK or
 * deployment dependencies to the generic Runtime Host. */
export async function loadManagedEnvironmentActivationPort(
  input: LoadManagedEnvironmentActivationPortInput,
): Promise<ManagedEnvironmentActivationPort> {
  if (input.provider.trim() === "") {
    throw new TypeError("Managed Environment activation provider must not be empty");
  }
  if (input.moduleSpecifier.trim() === "") {
    throw new TypeError("Managed Environment activation module specifier must not be empty");
  }
  const imported = await (input.importModule ?? importActivationModule)(input.moduleSpecifier);
  if (typeof imported !== "object" || imported === null) {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedEnvironmentActivationPort`,
    );
  }
  const factory = Reflect.get(imported, "createManagedEnvironmentActivationPort");
  if (typeof factory !== "function") {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedEnvironmentActivationPort`,
    );
  }
  const activation = await factory(input.factoryOptions) as ManagedEnvironmentActivationPort;
  if (
    typeof activation !== "object"
    || activation === null
    || typeof activation.descriptor !== "function"
    || typeof activation.activate !== "function"
    || typeof activation.reconcile !== "function"
  ) {
    throw new TypeError(`${input.moduleSpecifier} returned an invalid activation Port`);
  }
  const descriptor = activation.descriptor();
  if (descriptor.provider !== input.provider) {
    throw new Error(
      `Configured provider ${input.provider} loaded ${input.moduleSpecifier}, which advertised provider ${descriptor.provider}`,
    );
  }
  if (descriptor.strategy !== "acquire_then_session_poll") {
    throw new Error(
      `${input.moduleSpecifier} advertised unsupported activation strategy ${String(descriptor.strategy)}`,
    );
  }
  return activation;
}

async function importActivationModule(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}
