import type { HarnessInterface } from "./interface";

type HarnessFactory = () => HarnessInterface;

const registry = new Map<string, HarnessFactory>();

export function registerHarness(name: string, factory: HarnessFactory) {
  registry.set(name, factory);
}

export function resolveHarness(name?: string): HarnessInterface {
  const key = name || "default";
  const factory = registry.get(key);
  if (!factory) {
    throw new Error(`Unknown harness: "${key}". Registered: ${[...registry.keys()].join(", ")}`);
  }
  return factory();
}
