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

// --- Composition root: register harnesses here ---
import { registerHarness } from "./harness/registry";
import { DefaultHarness } from "./harness/default-loop";

registerHarness("default", () => new DefaultHarness());
// Future: registerHarness("coding", () => new CodingHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { Sandbox } from "@cloudflare/sandbox";

// --- Export outbound worker functions for container credential injection ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Console UI — served by Wrangler Assets (console/dist)
// SPA fallback handled by assets.not_found_handling = "single-page-application"

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
