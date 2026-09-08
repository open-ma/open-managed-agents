import { describe, expect, it, vi } from "vitest";

import { loadManagedEnvironmentActivationPort } from "../src/index";

function activation(provider: string) {
  return {
    descriptor: () => ({
      provider,
      version: "1.0.0",
      strategy: "acquire_then_session_poll" as const,
    }),
    activate: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
  };
}

describe("managed Environment activation adapter loader", () => {
  it("uses the native dynamic importer when no custom loader is supplied", async () => {
    const moduleSpecifier = `data:text/javascript,${encodeURIComponent(`
      export function createManagedEnvironmentActivationPort() {
        return {
          descriptor() { return { provider: "dynamic", version: "1", strategy: "acquire_then_session_poll" }; },
          async activate() {},
          async reconcile() {}
        };
      }
    `)}`;

    await expect(loadManagedEnvironmentActivationPort({
      provider: "dynamic",
      moduleSpecifier,
      factoryOptions: {},
    })).resolves.toMatchObject({ activate: expect.any(Function) });
  });

  it("imports only the selected adapter and passes opaque factory options", async () => {
    const selected = activation("aws-microvm");
    const factory = vi.fn(() => selected);
    const importModule = vi.fn(async (specifier: string) => {
      expect(specifier).toBe("@open-managed-agents/environment-activation-aws");
      return { createManagedEnvironmentActivationPort: factory };
    });
    const factoryOptions = { region: "us-east-1", launcher: "lambda" };

    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "@open-managed-agents/environment-activation-aws",
      factoryOptions,
      importModule,
    })).resolves.toBe(selected);
    expect(importModule).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(factoryOptions);
  });

  it("rejects a missing uniform factory export", async () => {
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "@open-managed-agents/environment-activation-aws",
      factoryOptions: {},
      importModule: async () => ({}),
    })).rejects.toThrow(/createManagedEnvironmentActivationPort/);
  });

  it("rejects an adapter whose provider identity does not match configuration", async () => {
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "@open-managed-agents/environment-activation-other",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentActivationPort: () => activation("other"),
      }),
    })).rejects.toThrow(/advertised provider other/);
  });

  it("rejects empty configuration, non-module imports, and invalid Ports", async () => {
    await expect(loadManagedEnvironmentActivationPort({
      provider: " ",
      moduleSpecifier: "adapter",
      factoryOptions: {},
    })).rejects.toThrow(/provider must not be empty/);
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: " ",
      factoryOptions: {},
    })).rejects.toThrow(/module specifier must not be empty/);
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => null,
    })).rejects.toThrow(/does not export/);
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentActivationPort: () => ({ descriptor() {} }),
      }),
    })).rejects.toThrow(/invalid activation Port/);
  });

  it("rejects a provider that advertises the wrong acquisition strategy", async () => {
    const selected = activation("aws-microvm") as any;
    selected.descriptor = () => ({
      provider: "aws-microvm",
      version: "1.0.0",
      strategy: "claim_then_acquire",
    });
    await expect(loadManagedEnvironmentActivationPort({
      provider: "aws-microvm",
      moduleSpecifier: "adapter",
      factoryOptions: {},
      importModule: async () => ({
        createManagedEnvironmentActivationPort: () => selected,
      }),
    })).rejects.toThrow(/unsupported activation strategy/);
  });
});
