// Bridges integrations-core's VaultManager port to apps/main via the MAIN
// service binding. Mirrors ServiceBindingSessionCreator's auth model — same
// shared internal secret.

import type {
  CreateCredentialInput,
  VaultManager,
} from "@open-managed-agents/integrations-core";

export interface ServiceBindingVaultManagerOptions {
  internalSecret: string;
  /** Path on apps/main. Defaults to "/v1/internal/vaults". */
  path?: string;
}

export class ServiceBindingVaultManager implements VaultManager {
  private readonly path: string;
  private readonly secret: string;

  constructor(
    private readonly main: Fetcher,
    opts: ServiceBindingVaultManagerOptions,
  ) {
    if (!opts.internalSecret) {
      throw new Error("ServiceBindingVaultManager: internalSecret required");
    }
    this.path = opts.path ?? "/v1/internal/vaults";
    this.secret = opts.internalSecret;
  }

  async createCredentialForUser(
    input: CreateCredentialInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    const res = await this.main.fetch(`http://main${this.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify({
        action: "create_with_credential",
        userId: input.userId,
        vaultName: input.vaultName,
        displayName: input.displayName,
        mcpServerUrl: input.mcpServerUrl,
        bearerToken: input.bearerToken,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`VaultManager.createCredentialForUser: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { vaultId: string; credentialId: string };
    return data;
  }
}
