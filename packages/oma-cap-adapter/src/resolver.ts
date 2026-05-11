// L3 adapter: implements `@open-managed-agents/cap`'s Resolver port against
// OMA's vaults-store + credentials-store + sessions-store.
//
// Encoding: cap's `Resolver` port carries an opaque `principal: string`.
// OMA encodes `${tenantId}|${sessionId}` so the resolver can look up the
// session's vault_ids and scan vault credentials for cap_cli matches by
// cli_id. The hostname argument is logged for audit but not used as the
// match key (cap registry already filtered by hostname before invoking).

import type {
  CredentialConfig,
  CredentialAuth,
} from "@open-managed-agents/shared";
import type {
  Resolver,
  ResolveInput,
  ResolvedToken,
} from "@open-managed-agents/cap";

export interface OmaResolverServices {
  readonly sessions: {
    get(opts: {
      tenantId: string;
      sessionId: string;
    }): Promise<{ archived_at?: string | null; vault_ids?: string[] | null } | null>;
  };
  readonly credentials: {
    listByVaults(opts: {
      tenantId: string;
      vaultIds: string[];
    }): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>>;
    update(opts: {
      tenantId: string;
      vaultId: string;
      credentialId: string;
      auth: Partial<CredentialAuth>;
    }): Promise<unknown>;
    create(opts: {
      tenantId: string;
      vaultId: string;
      displayName: string;
      auth: CredentialAuth;
    }): Promise<{ id: string }>;
  };
}

const PRINCIPAL_SEP = "|";

/**
 * Pack (tenantId, sessionId) into the opaque principal string cap passes
 * through its Resolver port. Production callers (the OMA L4 adapter)
 * MUST use this helper — the format is internal to OmaVaultResolver.
 */
export function encodePrincipal(tenantId: string, sessionId: string): string {
  return `${tenantId}${PRINCIPAL_SEP}${sessionId}`;
}

function decodePrincipal(principal: string): { tenantId: string; sessionId: string } | null {
  const idx = principal.indexOf(PRINCIPAL_SEP);
  if (idx <= 0 || idx === principal.length - 1) return null;
  return {
    tenantId: principal.slice(0, idx),
    sessionId: principal.slice(idx + 1),
  };
}

export class OmaVaultResolver implements Resolver {
  constructor(private readonly services: OmaResolverServices) {}

  async resolve(input: ResolveInput): Promise<ResolvedToken | null> {
    const decoded = decodePrincipal(input.principal);
    if (!decoded) return null;

    const session = await this.services.sessions
      .get({ tenantId: decoded.tenantId, sessionId: decoded.sessionId })
      .catch(() => null);
    if (!session || session.archived_at) return null;
    const vaultIds = session.vault_ids ?? [];
    if (vaultIds.length === 0) return null;

    const grouped = await this.services.credentials
      .listByVaults({ tenantId: decoded.tenantId, vaultIds })
      .catch(() => []);
    for (const g of grouped) {
      for (const cred of g.credentials) {
        const auth = cred.auth as CredentialAuth | undefined;
        if (!auth || auth.type !== "cap_cli") continue;
        if (auth.cli_id !== input.cli_id) continue;
        if (!auth.token) continue;
        return toResolvedToken(auth);
      }
    }
    return null;
  }

  /**
   * Mark the matched credential as needing refresh. v0 implementation:
   * no-op (the next resolve() naturally re-reads from D1 — there is no
   * in-memory cache layer to invalidate yet). When we add caching, this
   * is where we'd evict.
   *
   * Provider-tagged credentials (provider="github" / "linear") with short-
   * lived tokens already get refreshed by the integrations gateway out of
   * band; we don't trigger that here to keep this adapter pure-data.
   */
  async invalidate(_input: ResolveInput): Promise<void> {
    return;
  }

  /**
   * Persist `token` as the cap_cli credential at (principal, cli_id,
   * hostname). Called by L4 after a successful OAuth Device Flow
   * acquisition. Updates the existing credential if one matches the
   * (vault, cli_id) tuple; creates a new one otherwise.
   *
   * NOTE: store needs a target vault, but Resolver.store doesn't carry
   * one. v0 strategy: write into the FIRST vault on the session that
   * already has a cap_cli credential for this cli_id (in-place rotation),
   * else into the first session vault. If the session has no vaults,
   * store throws — the L4 caller should ensure a vault exists first.
   */
  async store(input: ResolveInput, token: ResolvedToken): Promise<void> {
    const decoded = decodePrincipal(input.principal);
    if (!decoded) {
      throw new Error(`OmaVaultResolver.store: malformed principal "${input.principal}"`);
    }
    const session = await this.services.sessions.get({
      tenantId: decoded.tenantId,
      sessionId: decoded.sessionId,
    });
    if (!session || session.archived_at) {
      throw new Error(
        `OmaVaultResolver.store: session not found for principal "${input.principal}"`,
      );
    }
    const vaultIds = session.vault_ids ?? [];
    if (vaultIds.length === 0) {
      throw new Error(
        `OmaVaultResolver.store: session has no vaults — create one first`,
      );
    }

    const grouped = await this.services.credentials.listByVaults({
      tenantId: decoded.tenantId,
      vaultIds,
    });
    // In-place update if (any vault, cli_id) match exists.
    for (const g of grouped) {
      for (const cred of g.credentials) {
        const auth = cred.auth as CredentialAuth | undefined;
        if (auth?.type === "cap_cli" && auth.cli_id === input.cli_id) {
          const updated = toCapCliAuth(input.cli_id, token);
          await this.services.credentials.update({
            tenantId: decoded.tenantId,
            vaultId: g.vault_id,
            credentialId: cred.id,
            auth: updated,
          });
          return;
        }
      }
    }
    // No existing match — create in the first vault.
    const firstVaultId = vaultIds[0];
    if (!firstVaultId) {
      throw new Error(`OmaVaultResolver.store: vault list empty after fetch`);
    }
    await this.services.credentials.create({
      tenantId: decoded.tenantId,
      vaultId: firstVaultId,
      displayName: `${input.cli_id} (auto-acquired)`,
      auth: toCapCliAuth(input.cli_id, token),
    });
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function toResolvedToken(auth: CredentialAuth): ResolvedToken {
  const out: { token: string; expires_at?: number; extras?: Readonly<Record<string, string>> } = {
    token: auth.token!,
  };
  if (auth.expires_at) {
    const ms = Date.parse(auth.expires_at);
    if (!Number.isNaN(ms)) out.expires_at = ms;
  }
  if (auth.extras && Object.keys(auth.extras).length > 0) {
    out.extras = auth.extras;
  }
  return out;
}

function toCapCliAuth(cli_id: string, token: ResolvedToken): CredentialAuth {
  const out: CredentialAuth = {
    type: "cap_cli",
    cli_id,
    token: token.token,
  };
  if (token.expires_at !== undefined) {
    out.expires_at = new Date(token.expires_at).toISOString();
  }
  if (token.extras) {
    if (token.extras.refresh_token) out.refresh_token = token.extras.refresh_token;
    out.extras = { ...token.extras };
  }
  return out;
}
