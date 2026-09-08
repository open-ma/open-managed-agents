import { describe, expect, it, vi } from "vitest";

import { loadManagedEnvironmentWorkDispatchPort } from "../src/index";

function dispatcher(provider: string) {
  return {
    descriptor: () => ({
      provider,
      version: "1.0.0",
      strategy: "poll_unacked_then_dispatch" as const,
    }),
    dispatch: vi.fn(async () => undefined),
  };
}

describe("Managed Environment dispatch adapter loader", () => {
  it("uses the native dynamic importer when no custom loader is supplied", async () => {
    const moduleSpecifier = `data:text/javascript,${encodeURIComponent(`
      export function createManagedEnvironmentWorkDispatchPort() {
        return {
          descriptor() { return { provider: "dynamic", version: "1", strategy: "poll_unacked_then_dispatch" }; },
          async dispatch() {}
        };
      }
    `)}`;

    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "dynamic",
      moduleSpecifier,
      factoryOptions: {},
    })).resolves.toMatchObject({ dispatch: expect.any(Function) });
  });

  it("loads only the selected isolated dispatch package", async () => {
    const selected = dispatcher("gke-agent-sandbox");
    const factory = vi.fn(() => selected);
    const importModule = vi.fn(async () => ({
      createManagedEnvironmentWorkDispatchPort: factory,
    }));
    const factoryOptions = { namespace: "agent-sandbox" };

    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "@open-managed-agents/environment-dispatch-gke",
      factoryOptions,
      importModule,
    })).resolves.toBe(selected);
    expect(importModule).toHaveBeenCalledWith(
      "@open-managed-agents/environment-dispatch-gke",
    );
    expect(factory).toHaveBeenCalledWith(factoryOptions);
  });

  it("rejects missing factories and mismatched provider identities", async () => {
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "@open-managed-agents/environment-dispatch-gke",
      factoryOptions: {},
      importModule: async () => ({}),
    })).rejects.toThrow(/createManagedEnvironmentWorkDispatchPort/);
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "@open-managed-agents/environment-dispatch-other",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentWorkDispatchPort: () => dispatcher("other"),
      }),
    })).rejects.toThrow(/advertised provider other/);
  });

  it("rejects empty configuration, non-module imports, and invalid Ports", async () => {
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: " ",
      moduleSpecifier: "adapter",
      factoryOptions: {},
    })).rejects.toThrow(/provider must not be empty/);
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: " ",
      factoryOptions: {},
    })).rejects.toThrow(/module specifier must not be empty/);
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => null,
    })).rejects.toThrow(/does not export/);
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentWorkDispatchPort: () => ({ descriptor() {} }),
      }),
    })).rejects.toThrow(/invalid dispatch Port/);
  });

  it("rejects a provider that advertises the wrong dispatch strategy", async () => {
    const selected = dispatcher("gke-agent-sandbox") as any;
    selected.descriptor = () => ({
      provider: "gke-agent-sandbox",
      version: "1.0.0",
      strategy: "claim_then_acquire",
    });
    await expect(loadManagedEnvironmentWorkDispatchPort({
      provider: "gke-agent-sandbox",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentWorkDispatchPort: () => selected,
      }),
    })).rejects.toThrow(/unsupported dispatch strategy/);
  });
});
