// Public types for the outbound-snapshots store. Mirrors the inline shape
// previously written at apps/agent/src/runtime/session-do.ts:469-479 and
// consumed at apps/agent/src/outbound.ts.
//
// The snapshot is the per-session, untenanted view that the outbound MITM
// worker reads to inject Authorization headers into the sandbox container's
// HTTPS calls. It carries plaintext OAuth material — TTL bounds the leak
// window when SessionDO's explicit /destroy cleanup doesn't run (DO eviction,
// sandbox crash, force-terminate).

/**
 * Per-session credential snapshot keyed only by `sessionId`.
 *
 * The shape matches the JSON the outbound worker walks at
 * apps/agent/src/outbound.ts:findCredentialForHost — it scans
 * `vault_credentials[*].credentials[*].auth.mcp_server_url` for a host match,
 * then injects either `auth.token` (static_bearer) or `auth.access_token`
 * (mcp_oauth). On 401 it uses `refresh_token` + `token_endpoint` + `client_id`
 * + optional `client_secret` to refresh, and writes the refreshed snapshot
 * back via the same key.
 */
export interface OutboundSnapshot {
  tenant_id: string;
  vault_ids: string[];
  vault_credentials: Array<{
    vault_id: string;
    credentials: Array<{
      id: string;
      auth?: {
        type: string;
        mcp_server_url?: string;
        token?: string;
        access_token?: string;
        refresh_token?: string;
        token_endpoint?: string;
        client_id?: string;
        client_secret?: string;
        expires_at?: string;
      };
    }>;
  }>;
}

/**
 * Canonical TTL for outbound snapshots — 24 hours. Matches the value
 * previously hard-coded at session-do.ts:132 and outbound.ts:209. The
 * snapshot contains plaintext OAuth tokens; this caps the leak window when
 * SessionDO's explicit /destroy cleanup doesn't run.
 */
export const DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
