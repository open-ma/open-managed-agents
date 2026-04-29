-- Local ACP runtime registration tables.
--
-- A "runtime" is one user laptop / VM running `oma bridge daemon`. It registers
-- with OMA via the connect-runtime browser flow → exchange code → token. After
-- that, the daemon holds a persistent reverse-WS to the RuntimeRoom DO and
-- relays ACP-protocol traffic for sessions whose AgentConfig has
-- runtime_binding pointing at this runtime's id.
--
-- House style: INTEGER unix-second timestamps, no FK constraints (cascade in
-- app layer per project convention), partial UNIQUE for active-only constraints.

-- ============================================================
-- RUNTIME REGISTRATION
-- One row per registered machine. owner_user_id + machine_id is the
-- idempotency key — re-running `oma bridge setup` from the same UNIX
-- user on the same machine reuses the row instead of inserting a dup.
-- ============================================================

CREATE TABLE IF NOT EXISTS "runtimes" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "owner_user_id"    TEXT NOT NULL,
  "owner_tenant_id"  TEXT NOT NULL,
  "machine_id"       TEXT NOT NULL,
  "hostname"         TEXT NOT NULL,
  "os"               TEXT NOT NULL,
  "agents_json"      TEXT NOT NULL DEFAULT '[]',
  "version"          TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'offline',
  "last_heartbeat"   INTEGER,
  "created_at"       INTEGER NOT NULL
);

-- Unique per (user, machine) — re-setup from same machine reuses row.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_runtimes_user_machine"
  ON "runtimes" ("owner_user_id", "machine_id");

-- Tenant-scoped listing.
CREATE INDEX IF NOT EXISTS "idx_runtimes_tenant"
  ON "runtimes" ("owner_tenant_id", "created_at" DESC);

-- ============================================================
-- RUNTIME TOKENS (sk_machine_*)
-- Bearer credential the daemon presents on /agents/runtime/_attach.
-- token_hash is sha256(plaintext); plaintext only ever transmitted once
-- in the /exchange response. Multiple tokens per runtime allowed (fresh
-- mint per `oma bridge setup` run); user revokes via UI to invalidate.
-- ============================================================

CREATE TABLE IF NOT EXISTS "runtime_tokens" (
  "id"                  TEXT PRIMARY KEY NOT NULL,
  "runtime_id"          TEXT NOT NULL,
  "token_hash"          TEXT NOT NULL UNIQUE,
  "created_by_user_id"  TEXT NOT NULL,
  "revoked_at"          INTEGER,
  "last_used_at"        INTEGER,
  "created_at"          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_runtime_tokens_runtime"
  ON "runtime_tokens" ("runtime_id", "revoked_at");

-- ============================================================
-- CONNECT-RUNTIME ONE-TIME CODES
-- Browser POSTs /v1/runtimes/connect-runtime → returns code (5 min TTL,
-- single-use). CLI receives via localhost callback redirect, exchanges
-- at /agents/runtime/exchange. Code rows linger after use for short-term
-- audit (used_at IS NOT NULL); a periodic GC sweep removes expired ones.
-- ============================================================

CREATE TABLE IF NOT EXISTS "connect_runtime_codes" (
  "code"        TEXT PRIMARY KEY NOT NULL,
  "user_id"     TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "state"       TEXT NOT NULL,
  "expires_at"  INTEGER NOT NULL,
  "used_at"     INTEGER
);

CREATE INDEX IF NOT EXISTS "idx_connect_runtime_codes_expires"
  ON "connect_runtime_codes" ("expires_at");
