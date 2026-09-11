import { Hono, type Context } from "hono";
import type { ApiKeyResolution, createAuthMiddleware } from "@open-managed-agents/auth";
import { buildOpenAIAgentsProtocolApi, OpenAIAgentsProtocolError, type OpenAIAgentsProtocolPort } from "@open-managed-agents/openai-agents-api";

export interface NodeOpenAIAgentsEnvironment {
  Variables: {
    tenant_id: string;
    user_id?: string;
    auth_credential?: ApiKeyResolution["credential"];
  };
}
export interface NodeOpenAIAgentsRoutesDependencies {
  authMiddleware: ReturnType<typeof createAuthMiddleware>;
  portFor(workspaceId: string, context: Context<NodeOpenAIAgentsEnvironment>): OpenAIAgentsProtocolPort;
}

/** Mount at /openai so official clients use baseURL /openai/v1. Authentication
 * and workspace membership stay in the existing shared middleware. */
export function buildNodeOpenAIAgentsRoutes(dependencies: NodeOpenAIAgentsRoutesDependencies): Hono<NodeOpenAIAgentsEnvironment> {
  const app = new Hono<NodeOpenAIAgentsEnvironment>();
  app.use("*", async (c, next) => {
    await next();
    if (c.res.status !== 401 && c.res.status !== 403) return;
    let message = c.res.status === 401 ? "Authentication required" : "Permission denied";
    try {
      const body = await c.res.clone().json() as { error?: string | { message?: string } };
      if (typeof body.error === "string") message = body.error;
      else if (typeof body.error?.message === "string") message = body.error.message;
    } catch { /* Keep a stable public authentication error for non-JSON middleware. */ }
    c.res = new Response(JSON.stringify({ error: {
      message, type: c.res.status === 401 ? "authentication_error" : "permission_error",
      param: null, code: c.res.status === 401 ? "invalid_api_key" : "insufficient_permissions",
    } }), { status: c.res.status, headers: { "content-type": "application/json" } });
  });
  app.use("*", dependencies.authMiddleware);
  app.route("/", buildOpenAIAgentsProtocolApi(context => {
    const c = context as Context<NodeOpenAIAgentsEnvironment>;
    const workspaceId = c.get("tenant_id");
    if (!workspaceId) throw new OpenAIAgentsProtocolError(401, "Authentication required");
    const credential = c.get("auth_credential");
    if (credential && credential.type !== "workspace") throw new OpenAIAgentsProtocolError(403, "This credential cannot access the Agents API");
    return dependencies.portFor(workspaceId, c);
  }));
  // A mounted Hono router does not carry its notFound handler into the host.
  // End this namespace explicitly before a host's console / SPA fallback.
  app.all("*", c => c.json({ error: {
    message: "Unknown API endpoint", type: "invalid_request_error",
    param: null, code: "resource_not_found",
  } }, 404));
  return app;
}
