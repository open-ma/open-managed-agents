import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Env } from "@open-managed-agents/shared";
import * as schema from "./db/schema";

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
      sendResetPassword: async ({ user, url }) => {
        if ((env as any).SEND_EMAIL) {
          await (env as any).SEND_EMAIL.send({
            to: [{ email: user.email }],
            from: { email: "noreply@openma.dev", name: "openma" },
            subject: "Reset your password",
            text: `Click here to reset your password: ${url}`,
            html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
          });
        } else {
          console.log(`[auth] Password reset for ${user.email}: ${url}`);
        }
      },
    },
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
            // Auto-create a tenant for each new user
            const tenantId = `tn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            const now = Math.floor(Date.now() / 1000);
            const stmt = env.AUTH_DB.prepare(
              "INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)"
            );
            await stmt.bind(tenantId, `${user.name}'s workspace`, now, now).run();
            // Assign tenant to user with owner role
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
