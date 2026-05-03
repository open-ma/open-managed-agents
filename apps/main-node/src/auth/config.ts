// CFless better-auth configuration. Sqlite-backed regardless of the main
// DB backend — auth tables are tiny, bcrypt + session-token rows live
// alongside the main sqlite or in their own ./data/auth.db when the main
// store is Postgres. Postgres-backed auth is future work; the cost of two
// DB files in a PG-mode deploy is one extra backup target, acceptable for
// PoC.
//
// Mirrors apps/main/src/auth-config.ts at the configuration level (email +
// password, optional Google OAuth, sign-up auto-creates a tenant via the
// databaseHooks.user.create.after path) — just without the email
// verification + OTP plugin which would need an email-sender wired here
// (PoC ships with email verification disabled; the operator who needs it
// can set EMAIL_FROM + RESEND_API_KEY and we'll wire it in a follow-up).

import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { ensureTenantSqlite } from "./tenants.js";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface CreateAuthOpts {
  /** better-sqlite3 Database instance. Required — we don't support PG-backed
   *  auth yet. */
  authDb: unknown;
  /** Main SqlClient — used for the tenant + membership writes that
   *  better-auth's user.create hook fires. Stays decoupled from the
   *  better-auth schema so the main backend stays free to swap. */
  mainSql: SqlClient;
  /** Required for cookie signing; if missing we generate a per-process
   *  random one and warn (sessions won't survive a restart). */
  secret?: string;
  /** Public origin used for the cookie domain + redirect URLs. */
  baseURL?: string;
  /** Optional social providers — keys come from env vars. */
  google?: { clientId: string; clientSecret: string };
}

// `unknown`-typed auth instance to avoid leaking better-auth's huge
// generic surface into call sites. The handlers we need are pinned via
// the Auth type alias below.
// Use the unparameterized return type — strict generics would require
// duplicating betterAuth's option-driven type params at every call site.
export type Auth = {
  handler: (req: Request) => Promise<Response>;
  api: {
    getSession: (req: { headers: Headers }) => Promise<{
      user?: { id: string; name?: string | null; email?: string | null };
    } | null>;
  };
};

export function createAuth(opts: CreateAuthOpts): Auth {
  const socialProviders: Record<string, unknown> = {};
  if (opts.google) {
    socialProviders.google = opts.google;
  }

  const secret = opts.secret ?? randomFallbackSecret();

  return betterAuth({
    basePath: "/auth",
    secret,
    baseURL: opts.baseURL,
    // The kysely-adapter detection in @better-auth/kysely-adapter looks for
    // `aggregate in db` (better-sqlite3 marker) and wires SqliteDialect
    // automatically. So a plain `new Database(path)` works as `database`.
    database: opts.authDb as never,
    emailAndPassword: {
      enabled: true,
      // PoC: skip email verification. Add EMAIL_FROM + sendEmail integration
      // when the deployer wants it.
      requireEmailVerification: false,
    },
    plugins: [
      // emailOTP — the console's Login flow always sends a verify-signup OTP
      // after sign-up.email even when requireEmailVerification is false. We
      // wire the plugin so console doesn't 404 on
      // /auth/email-otp/send-verification-otp; the actual OTP delivery is
      // console.log on the CFless path (operator pipes stdout to a real
      // sender when they wire EMAIL_FROM + Resend/SES/etc).
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOnSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          const labels: Record<string, string> = {
            "sign-in": "sign-in code",
            "email-verification": "email-verification code",
            "forget-password": "password reset code",
          };
          const label = labels[type] ?? "verification code";
          // Print to stdout — local-dev users paste from the server log.
          // Prod deploys plug a real email sender here (operator passes a
          // sendEmail fn; out of scope for this PoC commit).
          // eslint-disable-next-line no-console
          console.log(`[auth-otp] ${label} for ${email}: ${otp}`);
        },
      }),
    ],
    socialProviders,
    trustedOrigins: opts.baseURL ? [opts.baseURL] : ["*"],
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false },
        role: { type: "string", required: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; name?: string | null; email?: string | null }) => {
            try {
              await ensureTenantSqlite(opts.mainSql, user.id, user.name, user.email);
            } catch (err) {
              // Don't block sign-up on tenant creation — the auth middleware's
              // self-heal path will retry on first authenticated request.
              console.error("[auth] user.create hook ensureTenant failed:", err);
            }
          },
        },
      },
    },
  }) as unknown as Auth;
}

function randomFallbackSecret(): string {
  console.warn(
    "[auth] BETTER_AUTH_SECRET not set — generating per-process random secret. " +
    "Sessions will not survive restart. Set BETTER_AUTH_SECRET in prod.",
  );
  // 32 bytes hex.
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
