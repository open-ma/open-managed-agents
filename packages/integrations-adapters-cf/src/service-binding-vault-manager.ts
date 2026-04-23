// Bridges integrations-core's VaultManager port to apps/main via the MAIN
// service binding. Mirrors ServiceBindingSessionCreator's auth model — same
// shared internal secret.

import type {
  CreateCommandSecretInput,
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
    return this.post({
      action: "create_with_credential",
      userId: input.userId,
      vaultName: input.vaultName,
      displayName: input.displayName,
      mcpServerUrl: input.mcpServerUrl,
      bearerToken: input.bearerToken,
      provider: input.provider,
    });
  }

  async addCommandSecretCredential(
    input: CreateCommandSecretInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    return this.post({
      action: "add_command_secret",
      userId: input.userId,
      vaultId: input.vaultId,
      vaultName: input.vaultName,
      displayName: input.displayName,
      commandPrefixes: input.commandPrefixes,
      envVar: input.envVar,
      token: input.token,
      provider: input.provider,
    });
  }

  async rotateBearerToken(input: {
    userId: string;
    vaultId: string;
    newBearerToken: string;
  }): Promise<boolean> {
    const res = await this.main.fetch(`http://main${this.path}/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify({
        action: "rotate_bearer",
        userId: input.userId,
        vaultId: input.vaultId,
        newToken: input.newBearerToken,
      }),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(
        `VaultManager.rotateBearerToken: ${res.status} ${await res.text()}`,
      );
    }
    return true;
  }

  async rotateCommandSecretToken(input: {
    userId: string;
    vaultId: string;
    envVar: string;
    newToken: string;
  }): Promise<boolean> {
    const res = await this.main.fetch(`http://main${this.path}/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify({
        action: "rotate_command_secret",
        userId: input.userId,
        vaultId: input.vaultId,
        envVar: input.envVar,
        newToken: input.newToken,
      }),
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      throw new Error(
        `VaultManager.rotateCommandSecretToken: ${res.status} ${await res.text()}`,
      );
    }
    return true;
  }

  private async post(body: object): Promise<{ vaultId: string; credentialId: string }> {
    const res = await this.main.fetch(`http://main${this.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`VaultManager: ${res.status} ${txt}`);
    }
    return (await res.json()) as { vaultId: string; credentialId: string };
  }
}
