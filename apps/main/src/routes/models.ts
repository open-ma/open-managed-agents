import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { kvKey, kvPrefix } from "../kv-helpers";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

interface ProviderModel {
  id: string;
  name: string;
}

// POST /v1/models/list — list models from a provider using an API key
// Body: { provider: "ant" | "oai", api_key: string } OR { model_card_id: string }
app.post("/list", async (c) => {
  const t = c.get("tenant_id");
  const body = await c.req.json<{
    provider?: string;
    api_key?: string;
    model_card_id?: string;
  }>();

  let provider = body.provider || "ant";
  let apiKey = body.api_key || "";

  // If model_card_id provided, look up the key
  if (body.model_card_id) {
    const [cardData, keyData] = await Promise.all([
      c.env.CONFIG_KV.get(kvKey(t, "modelcard", body.model_card_id)),
      c.env.CONFIG_KV.get(kvKey(t, "modelcard", `${body.model_card_id}:key`)),
    ]);
    if (!cardData || !keyData) return c.json({ error: "Model card not found" }, 404);
    const card = JSON.parse(cardData);
    provider = card.provider;
    apiKey = keyData;
  }

  if (!apiKey) return c.json({ error: "api_key is required" }, 400);

  try {
    const models = await fetchModels(provider, apiKey);
    return c.json({ data: models });
  } catch (err) {
    return c.json({ error: `Failed to fetch models: ${(err as Error).message}` }, 502);
  }
});

async function fetchModels(provider: string, apiKey: string): Promise<ProviderModel[]> {
  if (provider === "ant") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Anthropic API: ${res.status}`);
    const data = await res.json() as {
      data: Array<{ id: string; display_name: string }>;
    };
    return data.data.map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }

  if (provider === "oai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI API: ${res.status}`);
    const data = await res.json() as {
      data: Array<{ id: string }>;
    };
    // Filter to chat models only (skip embeddings, tts, etc.)
    const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
    return data.data
      .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, name: m.id }));
  }

  return [];
}

export default app;
