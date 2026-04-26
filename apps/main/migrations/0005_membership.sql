-- Pattern A multi-tenancy: per-user → per-tenant memberships.
--
-- Until now `user.tenantId` carried the (single) tenant a user belonged to.
-- A user can now belong to N tenants with distinct roles. The `user.tenantId`
-- column stays for now as a denormalized "default / first" tenant — the
-- cookie-auth path falls back to it when the client doesn't pin an active
-- tenant via header. A later migration can drop it once the column has zero
-- readers.
--
-- Per project convention (no FK constraints — see feedback-no-fk memory):
-- referential integrity is enforced in the application layer.

CREATE TABLE IF NOT EXISTS "membership" (
  "user_id"    TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "role"       TEXT NOT NULL DEFAULT 'member',     -- owner | admin | member
  "created_at" INTEGER NOT NULL,                    -- unix seconds
  PRIMARY KEY ("user_id", "tenant_id")
);

CREATE INDEX IF NOT EXISTS "idx_membership_user"   ON "membership" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_membership_tenant" ON "membership" ("tenant_id");

-- Backfill: every existing user with a tenantId becomes an owner of that
-- tenant. INSERT OR IGNORE makes the migration idempotent if it ever
-- partially-runs and is re-applied.
INSERT OR IGNORE INTO "membership" (user_id, tenant_id, role, created_at)
SELECT
  id          AS user_id,
  tenantId    AS tenant_id,
  COALESCE(role, 'owner') AS role,                  -- legacy users were owners
  COALESCE(createdAt, CAST(strftime('%s','now') AS INTEGER)) AS created_at
FROM "user"
WHERE tenantId IS NOT NULL;
