// Thin shim — exposes the legacy `createAuth(opts)` signature backed by
// @open-managed-agents/auth-config + a logger-backed sender. The
// pg-better-auth.test.ts file imports from this path; keep it stable for
// the test surface even after main-node's runtime moved to package mounts.

import {
  buildBetterAuth,
  ensureTenantSqlite,
} from "@open-managed-agents/auth-config";
import type { EmailSender } from "@open-managed-agents/email";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("auth-otp");

export interface CreateAuthOpts {
  database: unknown;
  mainSql: SqlClient;
  secret?: string;
  baseURL?: string;
  google?: { clientId: string; clientSecret: string };
}

// Logger-backed sender that prints OTP codes to stdout. Used in
// no-SMTP self-host (and the pg-better-auth test) so emailOTP-based
// flows still function with a visible signal.
const stdoutSender: EmailSender = {
  send: async ({ to, subject, text }) => {
    log.info({ op: "auth_otp.send", to, subject, text }, `${subject} for ${to}: ${text}`);
  },
};

// Auth shape the legacy code expected. Identical to BetterAuth's
// runtime surface — kept narrow to avoid leaking better-auth's
// generics into call sites.
export type Auth = {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (req: { headers: Headers }) => Promise<{
      user?: { id: string; name?: string | null; email?: string | null };
    } | null>;
  };
};

export function createAuth(opts: CreateAuthOpts): Auth {
  const inst = buildBetterAuth({
    database: opts.database,
    sender: stdoutSender,
    secret: opts.secret ?? randomFallback(),
    baseURL: opts.baseURL,
    googleClientId: opts.google?.clientId,
    googleClientSecret: opts.google?.clientSecret,
    requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
    cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
    ensureTenant: (u) => ensureTenantSqlite(opts.mainSql, u.id, u.name, u.email),
  });
  // Cast to the legacy Auth shape — better-auth's generic over options is
  // too narrow for the structural shape we expose externally.
  return inst as unknown as Auth;
}

function randomFallback(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

