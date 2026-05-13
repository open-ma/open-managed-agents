// Adapter that builds a per-request `RouteServices` bundle from the CF
// per-tenant Services container resolved by `servicesMiddleware`. Used by
// the http-routes package factories — they call this on every request via
// the `(c) => RouteServices` form so the per-tenant D1 binding flows
// through naturally.

import type { Context } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { RouteServices } from "@open-managed-agents/http-routes";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

interface AppContextLike {
  Bindings: Env;
  Variables: { tenant_id: string; services: Services; tenantDb: D1Database };
}

export function cfRouteServices(c: Context<AppContextLike>): RouteServices {
  const services = c.var.services;
  const sql = new CfD1SqlClient(c.var.tenantDb);
  return {
    sql,
    agents: services.agents,
    vaults: services.vaults,
    credentials: services.credentials,
    memory: services.memory,
    sessions: services.sessions,
    kv: services.kv,
    // The http-routes session package uses these for SSE + event-log writes.
    // CF doesn't read events from SQL — events live in SessionDO storage.
    // Sessions extraction routes events through SessionRouter, which means
    // CF never invokes the SQL event log path; these are present so the
    // type checker is happy.
    newEventLog: () => ({
      appendAsync: async () => {},
      getEventsAsync: async () => [],
    }),
    hub: {
      publish: () => {},
      attach: () => () => {},
    },
    background: {
      run: (p) => {
        c.executionCtx.waitUntil(p.catch(() => undefined));
      },
    },
    outputsRoot: null,
  };
}
