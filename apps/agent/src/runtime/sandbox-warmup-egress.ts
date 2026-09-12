import type { SandboxExecutor } from "../harness/interface";

export interface SandboxWarmupEgressContext {
  tenantId: string;
  sessionId: string;
}

/**
 * Establish the sandbox's network policy before warmup performs any operation
 * that can leave the container (package installation, repository checkout,
 * MCP discovery, and so on). Runtimes with native networking may omit the
 * hook; intercepted runtimes such as Cloudflare install their TLS handler and
 * per-host credential routes here.
 */
export async function prepareSandboxEgress(
  sandbox: Pick<SandboxExecutor, "setOutboundContext">,
  context: SandboxWarmupEgressContext,
): Promise<void> {
  await sandbox.setOutboundContext?.({
    tenantId: context.tenantId,
    sessionId: context.sessionId,
  });
}
