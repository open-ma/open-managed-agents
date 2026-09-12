import { describe, expect, it } from "vitest";

import {
  SANDBOX_PROVIDER_PATHS,
  resolveSandboxProviderModule,
} from "../src/sandbox-provider";

describe("main-node sandbox provider selection", () => {
  it("resolves supported isolated providers", () => {
    expect(resolveSandboxProviderModule(" E2B ")).toEqual({
      provider: "e2b",
      modulePath: "@open-managed-agents/sandbox-adapter-e2b",
    });
    expect(resolveSandboxProviderModule("boxlite")).toEqual({
      provider: "boxlite",
      modulePath: "@open-managed-agents/sandbox-adapter-litebox",
    });
    expect(resolveSandboxProviderModule("Sprites")).toEqual({
      provider: "sprites",
      modulePath: "@open-managed-agents/managed-runtime-sprites",
    });
  });

  it.each([undefined, "", "   "])(
    "requires an explicit provider (%s)",
    (provider) => {
      expect(() => resolveSandboxProviderModule(provider)).toThrow(
        /SANDBOX_PROVIDER is required/,
      );
    },
  );

  it.each(["subprocess", " SubProcess "])(
    "rejects the non-isolated subprocess adapter (%s)",
    (provider) => {
      expect(() => resolveSandboxProviderModule(provider)).toThrow(
        /subprocess.*test-only/i,
      );
    },
  );

  it("does not expose subprocess as a production provider", () => {
    expect(SANDBOX_PROVIDER_PATHS).not.toHaveProperty("subprocess");
  });

  it("lists the isolated providers when selection is invalid", () => {
    expect(() => resolveSandboxProviderModule("unknown")).toThrow(
      /sprites, litebox, boxlite, boxrun, daytona, e2b/,
    );
  });
});
