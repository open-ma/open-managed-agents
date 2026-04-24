// Public types for the vaults store. Mirrors the D1 schema in
// apps/main/migrations/0014_vaults_table.sql.
//
// A "vault" is a tenant-scoped credential collection. The credentials
// themselves live in packages/credentials-store (one row per credential,
// vault_id is a soft FK). Cascade-archive is in the app layer (vaults
// route handler) — see CASCADE NOTE below.
//
// CASCADE NOTE:
//   When a vault is archived (POST /v1/vaults/:id/archive), the route
//   handler must ALSO call credentialsService.archiveByVault(...). The
//   vaults-store does NOT know about credentials — the route handler
//   orchestrates the cross-store cascade.

export interface VaultRow {
  id: string;
  tenant_id: string;
  name: string;
  created_at: string;
  updated_at: string | null;
  archived_at: string | null;
}
