// /v1/billing/* — thin proxy to the usage-meter worker's HTTP routes.
//
// We don't try to model billing in OSS — pricing, checkouts, refunds,
// subscription rollovers all live in whatever USAGE_METER_HTTP is
// bound to. main's only job is stamping the authenticated tenant id
// onto the forwarded request so the meter doesn't have to re-do auth.
//
// When the binding is absent (self-host), every endpoint returns 501.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

app.all("*", async (c) => {
  const meter = c.env.USAGE_METER_HTTP;
  if (!meter) {
    return c.json(
      { error: "Billing not configured for this deployment" },
      501,
    );
  }

  // Reconstruct the forwarded URL on a placeholder host — service
  // bindings ignore the host but Workers' Request constructor needs a
  // valid URL.
  const incoming = new URL(c.req.url);
  const upstream = new URL(`https://meter${incoming.pathname}${incoming.search}`);

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oma-tenant-id", c.var.tenant_id);
  // Strip auth headers — meter trusts the tenant header set by main and
  // doesn't need to see the user's session cookie.
  headers.delete("cookie");
  headers.delete("authorization");

  const init: RequestInit = {
    method: c.req.method,
    headers,
    body:
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : c.req.raw.body,
  };

  return meter.fetch(new Request(upstream.toString(), init));
});

export default app;
