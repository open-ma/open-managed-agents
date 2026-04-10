import { Hono } from "hono";
import type { Env } from "./env";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware } from "./rate-limit";
import agentsRoutes from "./routes/agents";
import environmentsRoutes from "./routes/environments";
import sessionsRoutes from "./routes/sessions";
import vaultsRoutes from "./routes/vaults";
import memoryRoutes from "./routes/memory";
import filesRoutes from "./routes/files";
import skillsRoutes from "./routes/skills";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// BuilderSandbox is DinD — builds and deploys sandbox workers.

// Re-export Sandbox as BuilderSandbox for the DinD builder container binding
export { Sandbox as BuilderSandbox } from "@cloudflare/sandbox";

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
app.route("/v1/agents", agentsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/memory_stores", memoryRoutes);
app.route("/v1/files", filesRoutes);
app.route("/v1/skills", skillsRoutes);

export default app;
