import type { ManagedEnvironmentWorkDispatchPort } from "./dispatched-environment-worker";

export interface ManagedEnvironmentWorkDispatchModule {
  createManagedEnvironmentWorkDispatchPort(
    factoryOptions: unknown,
  ): ManagedEnvironmentWorkDispatchPort | Promise<ManagedEnvironmentWorkDispatchPort>;
}

export interface LoadManagedEnvironmentWorkDispatchPortInput {
  provider: string;
  moduleSpecifier: string;
  factoryOptions: unknown;
  importModule?(specifier: string): Promise<unknown>;
}

/** Lazy-load one provider control-plane dispatcher. Provider SDK clients and
 * Kubernetes/Cloud bindings remain private to that selected package. */
export async function loadManagedEnvironmentWorkDispatchPort(
  input: LoadManagedEnvironmentWorkDispatchPortInput,
): Promise<ManagedEnvironmentWorkDispatchPort> {
  if (input.provider.trim() === "") {
    throw new TypeError("Managed Environment dispatch provider must not be empty");
  }
  if (input.moduleSpecifier.trim() === "") {
    throw new TypeError("Managed Environment dispatch module specifier must not be empty");
  }
  const imported = await (input.importModule ?? importDispatchModule)(input.moduleSpecifier);
  if (typeof imported !== "object" || imported === null) {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedEnvironmentWorkDispatchPort`,
    );
  }
  const factory = Reflect.get(imported, "createManagedEnvironmentWorkDispatchPort");
  if (typeof factory !== "function") {
    throw new TypeError(
      `${input.moduleSpecifier} does not export createManagedEnvironmentWorkDispatchPort`,
    );
  }
  const dispatcher = await factory(input.factoryOptions) as ManagedEnvironmentWorkDispatchPort;
  if (
    typeof dispatcher !== "object"
    || dispatcher === null
    || typeof dispatcher.descriptor !== "function"
    || typeof dispatcher.dispatch !== "function"
  ) {
    throw new TypeError(`${input.moduleSpecifier} returned an invalid dispatch Port`);
  }
  const descriptor = dispatcher.descriptor();
  if (descriptor.provider !== input.provider) {
    throw new Error(
      `Configured provider ${input.provider} loaded ${input.moduleSpecifier}, which advertised provider ${descriptor.provider}`,
    );
  }
  if (descriptor.strategy !== "poll_unacked_then_dispatch") {
    throw new Error(
      `${input.moduleSpecifier} advertised unsupported dispatch strategy ${String(descriptor.strategy)}`,
    );
  }
  return dispatcher;
}

async function importDispatchModule(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}
