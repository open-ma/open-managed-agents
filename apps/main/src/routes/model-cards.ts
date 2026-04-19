import { Hono } from "hono";
import type { Env, ModelCard } from "@open-managed-agents/shared";
import { generateModelCardId } from "@open-managed-agents/shared";
import { kvKey, kvPrefix, kvListAll } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

function formatModelCard(card: ModelCard) {
  return {
    ...card,
    archived_at: card.archived_at || null,
  };
}

// POST /v1/model_cards — create
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{
    name: string;
    provider: string;
    model_id: string;
    api_key: string;
    base_url?: string;
    custom_headers?: Record<string, string>;
    is_default?: boolean;
  }>();

  if (!body.name || !body.provider || !body.model_id || !body.api_key) {
    return c.json({ error: "name, provider, model_id, and api_key are required" }, 400);
  }

  // Unique model_id check
  const existing = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "modelcard"));
  for (const k of existing) {
    if (k.name.includes(":key")) continue;
    const data = await c.env.CONFIG_KV.get(k.name);
    if (data) {
      const card = JSON.parse(data) as ModelCard;
      if (!card.archived_at && card.model_id === body.model_id) {
        return c.json({ error: `model_id "${body.model_id}" is already used by model card "${card.name}" (${card.id})` }, 409);
      }
    }
  }

  const now = new Date().toISOString();
  const id = generateModelCardId();

  // If marking as default, unset other defaults
  if (body.is_default) {
    await clearDefaults(c.env.CONFIG_KV, t);
  }

  const card: ModelCard = {
    id,
    name: body.name,
    provider: body.provider,
    model_id: body.model_id,
    api_key_preview: body.api_key.slice(-4),
    base_url: body.base_url,
    custom_headers: body.custom_headers,
    is_default: body.is_default || false,
    created_at: now,
    updated_at: now,
  };

  await c.env.CONFIG_KV.put(kvKey(t, "modelcard", id), JSON.stringify(card));
  await c.env.CONFIG_KV.put(kvKey(t, "modelcard", `${id}:key`), body.api_key);

  return c.json(formatModelCard(card), 201);
});

// GET /v1/model_cards — list
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const list = await kvListAll(c.env.CONFIG_KV, kvPrefix(t, "modelcard"));
  const cards = (
    await Promise.all(
      list
        .filter((k) => !k.name.includes(":key"))
        .map(async (k) => {
          const data = await c.env.CONFIG_KV.get(k.name);
          return data ? formatModelCard(JSON.parse(data)) : null;
        })
    )
  ).filter((c): c is NonNullable<typeof c> => c !== null && !c.archived_at);

  cards.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return c.json({ data: cards });
});

// GET /v1/model_cards/:id — get single
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "modelcard", id));
  if (!data) return c.json({ error: "Model card not found" }, 404);
  return c.json(formatModelCard(JSON.parse(data)));
});

// POST /v1/model_cards/:id — update
app.post("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "modelcard", id));
  if (!data) return c.json({ error: "Model card not found" }, 404);

  const card: ModelCard = JSON.parse(data);
  const body = await c.req.json<{
    name?: string;
    provider?: string;
    model_id?: string;
    api_key?: string;
    base_url?: string | null;
    custom_headers?: Record<string, string> | null;
    is_default?: boolean;
  }>();

  if (body.is_default) {
    await clearDefaults(c.env.CONFIG_KV, t);
  }

  if (body.name !== undefined) card.name = body.name;
  if (body.provider !== undefined) card.provider = body.provider;
  if (body.model_id !== undefined) card.model_id = body.model_id;
  if (body.base_url !== undefined) card.base_url = body.base_url || undefined;
  if (body.custom_headers !== undefined) card.custom_headers = body.custom_headers || undefined;
  if (body.is_default !== undefined) card.is_default = body.is_default;
  if (body.api_key) {
    card.api_key_preview = body.api_key.slice(-4);
    await c.env.CONFIG_KV.put(kvKey(t, "modelcard", `${id}:key`), body.api_key);
  }
  card.updated_at = new Date().toISOString();

  await c.env.CONFIG_KV.put(kvKey(t, "modelcard", id), JSON.stringify(card));
  return c.json(formatModelCard(card));
});

// DELETE /v1/model_cards/:id — delete
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(kvKey(t, "modelcard", id));
  if (!data) return c.json({ error: "Model card not found" }, 404);

  await c.env.CONFIG_KV.delete(kvKey(t, "modelcard", id));
  await c.env.CONFIG_KV.delete(kvKey(t, "modelcard", `${id}:key`));
  return c.json({ type: "model_card_deleted", id });
});

// GET /v1/model_cards/:id/key — internal: get actual API key (used by agent worker)
app.get("/:id/key", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const key = await c.env.CONFIG_KV.get(kvKey(t, "modelcard", `${id}:key`));
  if (!key) return c.json({ error: "Key not found" }, 404);
  return c.json({ api_key: key });
});

async function clearDefaults(kv: KVNamespace, tenantId: string) {
  const list = await kvListAll(kv, kvPrefix(tenantId, "modelcard"));
  for (const k of list) {
    if (k.name.includes(":key")) continue;
    const data = await kv.get(k.name);
    if (!data) continue;
    const card: ModelCard = JSON.parse(data);
    if (card.is_default) {
      card.is_default = false;
      card.updated_at = new Date().toISOString();
      await kv.put(k.name, JSON.stringify(card));
    }
  }
}

export default app;
