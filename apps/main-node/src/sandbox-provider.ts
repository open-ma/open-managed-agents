export const SANDBOX_PROVIDER_PATHS = {
  sprites: "@open-managed-agents/managed-runtime-sprites",
  litebox: "@open-managed-agents/sandbox-adapter-litebox",
  boxlite: "@open-managed-agents/sandbox-adapter-litebox",
  boxrun: "@open-managed-agents/sandbox-adapter-boxrun",
  daytona: "@open-managed-agents/sandbox-adapter-daytona",
  e2b: "@open-managed-agents/sandbox-adapter-e2b",
} as const;

export type NodeSandboxProvider = keyof typeof SANDBOX_PROVIDER_PATHS;

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
