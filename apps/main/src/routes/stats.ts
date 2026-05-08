// /v1/stats — aggregate counts for the dashboard headline.
//
// Replaces the legacy "fetch /v1/agents?limit=1000 then read .data.length"
// pattern in console/Dashboard.tsx, which pulled every row across seven
// resources just to render seven numbers. Each store's count() runs as a
// covering-index COUNT(*) (idx_<table>_tenant); skills/api_keys are KV
// list-length lookups.
//
// All counts are scoped to the active tenant, exclude archived rows where
// the resource has that concept (agents/sessions/environments/vaults), and
// include only the items the dashboard headline cards represent.

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { kvPrefix, kvListAll } from "../kv-helpers";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

interface StatsResponse {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

app.get("/", async (c) => {
  const tenantId = c.get("tenant_id");
  const services = c.var.services;

  const [
    agents,
    sessions,
    environments,
    vaults,
    skillKeys,
    modelCards,
    apiKeyIndex,
  ] = await Promise.all([
    services.agents.count({ tenantId }),
    services.sessions.count({ tenantId }),
    services.environments.count({ tenantId }),
    services.vaults.count({ tenantId }),
    // Skills + api_keys live in KV; counts are key-scan / index-length, both
    // cheap relative to the old "fetch every row + .length" approach.
    kvListAll(services.kv, kvPrefix(tenantId, "skill")),
    services.modelCards.list({ tenantId }),
    services.kv.get(`t:${tenantId}:apikeys`),
  ]);

  const apiKeysList = apiKeyIndex
    ? (JSON.parse(apiKeyIndex) as Array<{ id: string }>)
    : [];

  const body: StatsResponse = {
    agents,
    sessions,
    environments,
    vaults,
    skills: skillKeys.length,
    model_cards: modelCards.filter((c) => c.archived_at === null).length,
    api_keys: apiKeysList.length,
  };
  return c.json(body);
});

export default app;
