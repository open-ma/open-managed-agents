import { Hono } from "hono";

import type { Context } from "hono";
import type { OmaModelsApplicationPort } from "@open-managed-agents/oma-models";

export type OmaApplicationPortResolver<Port> = (context: Context) => Port;
export type OmaApplicationPortSource<Port> =
  | Port
  | OmaApplicationPortResolver<Port>;

function resolveApplicationPort<Port>(
  source: OmaApplicationPortSource<Port>,
  context: Context,
): Port {
  return typeof source === "function"
    ? (source as OmaApplicationPortResolver<Port>)(context)
    : source;
}

export function buildOmaModelRoutes(
  source: OmaApplicationPortSource<OmaModelsApplicationPort>,
): Hono {
  const app = new Hono();

  app.post("/list", async (context) => {
    let body: { provider?: unknown; api_key?: unknown };
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "Invalid JSON body" }, 400);
    }
    const provider = typeof body.provider === "string" && body.provider.length > 0
      ? body.provider
      : "ant";
    const result = await resolveApplicationPort(source, context)
      .listProviderModels({
        provider,
        ...(typeof body.api_key === "string" && body.api_key.length > 0
          ? { apiKey: body.api_key }
          : {}),
      });
    if (result.type === "upstream_error") {
      return context.json({ error: result.message }, 502);
    }
    return context.json({ data: result.models }, 200);
  });

  return app;
}
