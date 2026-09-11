import { describe, expect, it, vi } from "vitest";

import { loadManagedRuntimeProviderDriver } from "../src/index";

function driver(provider: string) {
  return {
    descriptor: () => ({
      provider,
      version: "1.0.0",
      placements: ["in_process" as const],
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
  };
}

describe("managed runtime provider driver loader", () => {
  it("uses the native dynamic importer when no custom loader is supplied", async () => {
    const moduleSpecifier = `data:text/javascript,${encodeURIComponent(`
      export function createManagedRuntimeProviderDriver() {
        return {
          descriptor() { return { provider: "dynamic" }; },
          async create() {}
        };
      }
    `)}`;

    await expect(loadManagedRuntimeProviderDriver({
      provider: "dynamic",
      moduleSpecifier,
      factoryOptions: {},
    })).resolves.toMatchObject({ create: expect.any(Function) });
  });

  it("imports only the selected isolated adapter and passes its opaque factory options", async () => {
    const selected = driver("acme");
    const factory = vi.fn(() => selected);
    const importModule = vi.fn(async (specifier: string) => {
      expect(specifier).toBe("@open-managed-agents/managed-runtime-acme");
      return { createManagedRuntimeProviderDriver: factory };
    });
    const factoryOptions = { endpoint: "https://sandbox.acme.test" };

    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: "@open-managed-agents/managed-runtime-acme",
      factoryOptions,
      importModule,
    })).resolves.toBe(selected);
    expect(importModule).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(factoryOptions);
  });

  it("fails closed when the adapter lacks the standard factory export", async () => {
    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: "@open-managed-agents/managed-runtime-acme",
      factoryOptions: {},
      importModule: async () => ({}),
    })).rejects.toThrow(/createManagedRuntimeProviderDriver/);
  });

  it("rejects an adapter whose descriptor does not match the selected provider", async () => {
    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: "@open-managed-agents/managed-runtime-other",
      factoryOptions: {},
      importModule: async () => ({
        createManagedRuntimeProviderDriver: () => driver("other"),
      }),
    })).rejects.toThrow(/advertised provider other/);
  });

  it("rejects empty configuration, non-module imports, and invalid drivers", async () => {
    await expect(loadManagedRuntimeProviderDriver({
      provider: " ",
      moduleSpecifier: "adapter",
      factoryOptions: {},
    })).rejects.toThrow(/provider must not be empty/);
    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: " ",
      factoryOptions: {},
    })).rejects.toThrow(/module specifier must not be empty/);
    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => null,
    })).rejects.toThrow(/does not export/);
    await expect(loadManagedRuntimeProviderDriver({
      provider: "acme",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => ({
        createManagedRuntimeProviderDriver: () => ({ descriptor() {} }),
      }),
    })).rejects.toThrow(/invalid Managed Runtime driver/);
  });
});
