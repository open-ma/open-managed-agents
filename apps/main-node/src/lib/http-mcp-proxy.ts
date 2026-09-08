import { Hono } from "hono";
import {
  forwardWithRefresh,
  type OauthRefreshMetadata,
  type RefreshedTokens,
} from "@open-managed-agents/vault-forward";

export interface NodeMcpProxyTarget {
  upstreamUrl: string;
  accessToken: string;
  refresh?: OauthRefreshMetadata;
  onRefreshed?: (tokens: RefreshedTokens) => Promise<void>;
}

export interface NodeHttpMcpProxyDependencies {
  resolveTarget(input: {
    tenantId: string;
    sessionId: string;
    serverName: string;
  }): Promise<NodeMcpProxyTarget | null>;
  fetcher?: typeof fetch;
}

/** Node/self-host equivalent of the Cloudflare HTTP MCP gateway. Authentication
 * stays in the parent v1 middleware; this route consumes only its tenant
 * projection and never accepts tenant identity from request headers. */
export function buildNodeHttpMcpProxyRoutes(
  dependencies: NodeHttpMcpProxyDependencies,
) {
  const routes = new Hono<{ Variables: { tenant_id: string } }>();
  routes.all("/:sessionId/:serverName", async (context) => {
    const tenantId = context.get("tenant_id");
    const sessionId = context.req.param("sessionId");
    const serverName = context.req.param("serverName");
    const target = await dependencies.resolveTarget({
      tenantId,
      sessionId,
      serverName,
    });
    if (target === null) {
      return context.json({ error: "forbidden" }, 403);
    }

    const inboundHeaders = new Headers(context.req.raw.headers);
    const body = ["GET", "HEAD"].includes(context.req.method.toUpperCase())
      ? null
      : await context.req.raw.arrayBuffer();
    return forwardWithRefresh({
      upstreamUrl: target.upstreamUrl,
      method: context.req.method,
      inboundHeaders,
      body,
      accessToken: target.accessToken,
      refresh: target.refresh,
      onRefreshed: target.onRefreshed,
      fetcher: dependencies.fetcher,
    });
  });
  return routes;
}
