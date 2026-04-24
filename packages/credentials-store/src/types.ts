// Public types for the credentials store service. Mirrors the D1 schema in
// apps/main/migrations/0009_credentials_table.sql.

import type { CredentialAuth } from "@open-managed-agents/shared";

export interface CredentialRow {
  id: string;
  tenant_id: string;
  vault_id: string;
  display_name: string;
  /** Parsed CredentialAuth — adapters JSON.parse the `auth` column. */
  auth: CredentialAuth;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}

/** Hard cap mirrored from the previous KV-era check in vaults.ts:140. */
export const MAX_CREDENTIALS_PER_VAULT = 20;

/** Auth fields that must never leave the API. Used by `stripSecrets`. */
export const SECRET_AUTH_FIELDS: (keyof CredentialAuth)[] = [
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
];
