export const SANDBOX_PROVIDER_PATHS = {
  sprites: "@open-managed-agents/managed-runtime-sprites",
  litebox: "@open-managed-agents/sandbox-adapter-litebox",
  boxlite: "@open-managed-agents/sandbox-adapter-litebox",
  boxrun: "@open-managed-agents/sandbox-adapter-boxrun",
  daytona: "@open-managed-agents/sandbox-adapter-daytona",
  e2b: "@open-managed-agents/sandbox-adapter-e2b",
} as const;

export type NodeSandboxProvider = keyof typeof SANDBOX_PROVIDER_PATHS;

export type NodeSandboxProviderSelection =
  | {
      provider: NodeSandboxProvider;
      modulePath: (typeof SANDBOX_PROVIDER_PATHS)[NodeSandboxProvider];
    }
  | {
      provider: "test-local-subprocess";
      modulePath: "@open-managed-agents/sandbox/adapters/local-subprocess";
    };

export function resolveSandboxProviderModule(providerValue: string | undefined): {
  provider: NodeSandboxProvider;
  modulePath: (typeof SANDBOX_PROVIDER_PATHS)[NodeSandboxProvider];
} {
  const provider = providerValue?.trim().toLowerCase() ?? "";
  if (!provider) {
    throw new TypeError(
      `SANDBOX_PROVIDER is required; configure an isolated provider: ${Object.keys(SANDBOX_PROVIDER_PATHS).join(", ")}`,
    );
  }
  if (provider === "subprocess") {
    throw new TypeError(
      "SANDBOX_PROVIDER=subprocess is test-only and is not available from the production server",
    );
  }
  if (!(provider in SANDBOX_PROVIDER_PATHS)) {
    throw new TypeError(
      `SANDBOX_PROVIDER=${provider} not recognized; valid: ${Object.keys(SANDBOX_PROVIDER_PATHS).join(", ")}`,
    );
  }

  const normalizedProvider = provider as NodeSandboxProvider;
  return {
    provider: normalizedProvider,
    modulePath: SANDBOX_PROVIDER_PATHS[normalizedProvider],
  };
}

/**
 * Resolve the server composition without weakening the production provider
 * boundary. The local subprocess adapter exists solely for deterministic
 * process-level tests; setting its selector outside NODE_ENV=test fails
 * closed instead of silently running agent commands on the API host.
 */
export function resolveSandboxProviderForEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NodeSandboxProviderSelection {
  const testProvider = environment.OPENMA_TEST_SANDBOX_PROVIDER?.trim();
  if (testProvider !== undefined && testProvider.length > 0) {
    if (environment.NODE_ENV !== "test") {
      throw new TypeError(
        "OPENMA_TEST_SANDBOX_PROVIDER is test-only and cannot be used outside NODE_ENV=test",
      );
    }
    if (testProvider !== "local-subprocess") {
      throw new TypeError(
        `OPENMA_TEST_SANDBOX_PROVIDER=${testProvider} not recognized; valid: local-subprocess`,
      );
    }
    return {
      provider: "test-local-subprocess",
      modulePath: "@open-managed-agents/sandbox/adapters/local-subprocess",
    };
  }
  return resolveSandboxProviderModule(environment.SANDBOX_PROVIDER);
}
