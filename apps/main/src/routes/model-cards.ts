import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import {
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  type ModelCardRow,
} from "@open-managed-agents/model-cards-store";
import type { Services } from "@open-managed-agents/services";
import { jsonPage, parsePageQuery } from "../lib/list-page";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/**
 * Adapt a `ModelCardRow` to the legacy API shape that Console + CLI consume.
 * Differences vs. the row: `display_name` becomes `name`, optional fields are
 * surfaced as `undefined` (not `null`), and the row's internal `tenant_id` is
 * never exposed.
 */
function toApiShape(card: ModelCardRow) {
  return {
    id: card.id,
    name: card.display_name,
    provider: card.provider,
    model_id: card.model_id,
    api_key_preview: card.api_key_preview,
    base_url: card.base_url ?? undefined,
    custom_headers: card.custom_headers ?? undefined,
    is_default: card.is_default,
    created_at: card.created_at,
    updated_at: card.updated_at ?? undefined,
    archived_at: card.archived_at,
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
  try {
    const card = await c.var.services.modelCards.create({
      tenantId: t,
      modelId: body.model_id,
      provider: body.provider,
      displayName: body.name,
      apiKey: body.api_key,
      baseUrl: body.base_url ?? null,
      customHeaders: body.custom_headers ?? null,
      makeDefault: !!body.is_default,
    });
    return c.json(toApiShape(card), 201);
  } catch (err) {
    if (err instanceof ModelCardDuplicateModelIdError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// GET /v1/model_cards — list (cursor-paginated)
app.get("/", async (c) => {
  const page = await c.var.services.modelCards.listPage({
    tenantId: c.get("tenant_id"),
    ...parsePageQuery(c),
  });
  // Hide archived cards (forward-compat with soft-delete; today archived_at
  // is always null but the legacy KV path also filtered, so preserve parity).
  const filteredItems = page.items.filter((card) => card.archived_at === null);
  return jsonPage(c, { items: filteredItems, nextCursor: page.nextCursor }, toApiShape);
});

// GET /v1/model_cards/:id — get single
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const card = await c.var.services.modelCards.get({
    tenantId: t,
    cardId: c.req.param("id"),
  });
  if (!card) return c.json({ error: "Model card not found" }, 404);
  return c.json(toApiShape(card));
});

// POST /v1/model_cards/:id — update
app.post("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    provider?: string;
    model_id?: string;
    api_key?: string;
    base_url?: string | null;
    custom_headers?: Record<string, string> | null;
    is_default?: boolean;
  }>();
  try {
    const updated = await c.var.services.modelCards.update({
      tenantId: t,
      cardId: id,
      displayName: body.name,
      provider: body.provider,
      modelId: body.model_id,
      // Legacy route accepted `body.base_url || undefined` — translating
      // empty string to "no change". Match for backward compat: explicitly
      // set falsy → null (clear), undefined → leave alone.
      baseUrl: body.base_url === undefined
        ? undefined
        : (body.base_url || null),
      customHeaders: body.custom_headers === undefined
        ? undefined
        : (body.custom_headers || null),
      apiKey: body.api_key,
      isDefault: body.is_default,
    });
    return c.json(toApiShape(updated));
  } catch (err) {
    if (err instanceof ModelCardNotFoundError) {
      return c.json({ error: "Model card not found" }, 404);
    }
    if (err instanceof ModelCardDuplicateModelIdError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

// DELETE /v1/model_cards/:id — delete
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    await c.var.services.modelCards.delete({ tenantId: t, cardId: id });
    return c.json({ type: "model_card_deleted", id });
  } catch (err) {
    if (err instanceof ModelCardNotFoundError) {
      return c.json({ error: "Model card not found" }, 404);
    }
    throw err;
  }
});

// GET /v1/model_cards/:id/key — internal: get actual API key (used by agent worker)
app.get("/:id/key", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const apiKey = await c.var.services.modelCards.getApiKey({ tenantId: t, cardId: id });
  if (apiKey === null) return c.json({ error: "Key not found" }, 404);
  return c.json({ api_key: apiKey });
});

export default app;
