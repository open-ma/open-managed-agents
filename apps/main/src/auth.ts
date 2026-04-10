import { createMiddleware } from "hono/factory";
import type { Env } from "@open-managed-agents/shared";

export const authMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const key = c.req.header("x-api-key");
    if (!key || key !== c.env.API_KEY) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    await next();
  }
);
