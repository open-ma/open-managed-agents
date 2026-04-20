import { Hono } from "hono";
import type { Env } from "../../env";
import { buildContainer } from "../../wire";
import { buildProviders } from "../../providers";

// Linear B+ install entry. Called by apps/main via service binding (the
// Console's /v1/integrations/linear/install-shared proxy hits this). Locked
// down with the shared INTEGRATIONS_INTERNAL_SECRET header so it can't be
// invoked directly from the public internet.

const app = new Hono<{ Bindings: Env }>();

// Internal-only: require the shared secret header. Same pattern as the
// internal endpoints on apps/main.
app.use("*", async (c, next) => {
  const expected = c.env.INTEGRATIONS_INTERNAL_SECRET;
  const provided = c.req.header("x-internal-secret");
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/**
 * GET /linear/install
 *
 * Query params (set by apps/main proxy):
 *   user_id, agent_id, environment_id, mode, persona_name, persona_avatar (opt), return_to
 *
 * Responds with 302 to Linear's OAuth authorize URL.
 */
app.get("/install", async (c) => {
  const url = new URL(c.req.url);
  const userId = url.searchParams.get("user_id");
  const agentId = url.searchParams.get("agent_id");
  const environmentId = url.searchParams.get("environment_id");
  const mode = (url.searchParams.get("mode") ?? "quick") as "quick" | "full";
  const personaName = url.searchParams.get("persona_name");
  const personaAvatar = url.searchParams.get("persona_avatar");
  const returnTo = url.searchParams.get("return_to");

  if (!userId || !agentId || !environmentId || !personaName || !returnTo) {
    return c.json(
      {
        error:
          "missing required query params: user_id, agent_id, environment_id, persona_name, return_to",
      },
      400,
    );
  }

  const container = buildContainer(c.env);
  const { linear } = buildProviders(c.env, container);
  const result = await linear.startInstall({
    userId,
    agentId,
    environmentId,
    mode,
    persona: { name: personaName, avatarUrl: personaAvatar },
    returnUrl: returnTo,
  });

  if (result.kind === "step" && result.step === "redirect") {
    const targetUrl = result.data.url as string;
    return c.redirect(targetUrl, 302);
  }
  // Defensive — startInstall for B+ should always return a redirect step.
  return c.json({ error: "unexpected install result", result }, 500);
});

export default app;
