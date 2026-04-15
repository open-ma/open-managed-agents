import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware } from "./rate-limit";
import agentsRoutes from "./routes/agents";
import environmentsRoutes from "./routes/environments";
import sessionsRoutes from "./routes/sessions";
import vaultsRoutes from "./routes/vaults";
import oauthRoutes from "./routes/oauth";
import memoryRoutes from "./routes/memory";
import filesRoutes from "./routes/files";
import skillsRoutes from "./routes/skills";
import modelCardsRoutes from "./routes/model-cards";
import modelsRoutes from "./routes/models";
import clawhubRoutes from "./routes/clawhub";
import apiKeysRoutes from "./routes/api-keys";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Auth routes (public — no authMiddleware)
// Lazy import to avoid crashing workerd in test environments
app.on(["GET", "POST"], "/auth/*", async (c) => {
  if (!c.env.AUTH_DB) return c.json({ error: "Auth not configured" }, 503);
  const { createAuth } = await import("./auth-config");
  return createAuth(c.env).handler(c.req.raw);
});

// Auth info endpoint (public — tells the frontend which providers are enabled)
app.get("/auth-info", (c) => {
  const providers: string[] = ["email"];
  if (c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  return c.json({ providers });
});

// API routes (require authentication)
app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
app.route("/v1/agents", agentsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/oauth", oauthRoutes);
app.route("/v1/memory_stores", memoryRoutes);
app.route("/v1/files", filesRoutes);
app.route("/v1/skills", skillsRoutes);
app.route("/v1/model_cards", modelCardsRoutes);
app.route("/v1/models", modelsRoutes);
app.route("/v1/clawhub", clawhubRoutes);
app.route("/v1/api_keys", apiKeysRoutes);

export default app;
