import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import type { Env } from "@open-managed-agents/shared";
import * as schema from "./db/schema";

function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string,
) {
  if (!env.SEND_EMAIL) {
    console.log(`[auth] email not sent to ${to} (SEND_EMAIL binding not configured): ${subject}`);
    return;
  }
  return env.SEND_EMAIL.send({
    from: "openma <noreply@openma.dev>",
    to,
    subject,
    html,
    text,
  });
}

function otpEmailHtml(code: string, label: string): string {
  return [
    '<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px">',
    `<h2 style="margin:0 0 16px">${label}</h2>`,
    `<p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0">${code}</p>`,
    '<p style="color:#666;font-size:14px">This code expires in 5 minutes. If you did not request this, ignore this email.</p>',
    "</div>",
  ].join("");
}

export function createAuth(env: Env) {
  const db = drizzle(env.AUTH_DB, { schema });

  const socialProviders: Record<string, unknown> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  return betterAuth({
    basePath: "/auth",
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(
          env,
          user.email,
          "Reset your password — openma",
          `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Reset your password</h2><p>Click the button below to reset your password.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Reset password</a><p style="color:#666;font-size:14px">If you did not request this, ignore this email.</p></div>`,
          `Reset your password: ${url}`,
        );
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(
          env,
          user.email,
          "Verify your email — openma",
          `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2>Verify your email</h2><p>Click the button below to verify your email address.</p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:6px;margin:16px 0">Verify email</a><p style="color:#666;font-size:14px">If you did not create an account, ignore this email.</p></div>`,
          `Verify your email: ${url}`,
        );
      },
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        sendVerificationOnSignUp: true,
        async sendVerificationOTP({ email, otp, type }) {
          const labels: Record<string, string> = {
            "sign-in": "Your sign-in code",
            "email-verification": "Verify your email",
            "forget-password": "Your password reset code",
          };
          const label = labels[type] ?? "Your verification code";
          await sendEmail(
            env,
            email,
            `${label} — openma`,
            otpEmailHtml(otp, label),
            `${label}: ${otp}`,
          );
        },
      }),
    ],
    socialProviders,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    trustedOrigins: ["*"],
    user: {
      additionalFields: {
        tenantId: { type: "string", required: false },
        role: { type: "string", required: false, defaultValue: "member" },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const tenantId = `tn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            const now = Math.floor(Date.now() / 1000);
            const stmt = env.AUTH_DB.prepare(
              "INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)"
            );
            await stmt.bind(tenantId, `${user.name}'s workspace`, now, now).run();
            const update = env.AUTH_DB.prepare(
              "UPDATE user SET tenantId = ?, role = ? WHERE id = ?"
            );
            await update.bind(tenantId, "owner", user.id).run();
          },
        },
      },
    },
  });
}

/**
 * Look up a user's tenantId from D1.
 */
export async function getTenantId(db: D1Database, userId: string): Promise<string | null> {
  const result = await db
    .prepare("SELECT tenantId FROM user WHERE id = ?")
    .bind(userId)
    .first<{ tenantId: string | null }>();
  return result?.tenantId ?? null;
}
