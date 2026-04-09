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
app.get("/", (c) => c.redirect("/console"));

// Console GUI — served as static HTML
import consoleHtml from "./console.html";
app.get("/console", (c) =>
  c.html(consoleHtml as unknown as string)
);

app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
app.route("/v1/agents", agentsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/memory_stores", memoryRoutes);
app.route("/v1/files", filesRoutes);

export default app;
