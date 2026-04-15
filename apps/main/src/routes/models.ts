import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

interface ProviderModel {
  id: string;
  name: string;
}

const ANTHROPIC_MODELS: ProviderModel[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

const OPENAI_MODELS: ProviderModel[] = [
  { id: "o3", name: "o3" },
  { id: "o4-mini", name: "o4-mini" },
  { id: "gpt-4.1", name: "GPT-4.1" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano" },
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "o3-mini", name: "o3-mini" },
  { id: "o1", name: "o1" },
  { id: "o1-mini", name: "o1-mini" },
];

// GET /v1/models/list?provider=ant — list known models for a provider (no API key needed)
app.get("/list", async (c) => {
  const provider = c.req.query("provider") || "ant";

  if (provider === "ant") return c.json({ data: ANTHROPIC_MODELS });
  if (provider === "oai") return c.json({ data: OPENAI_MODELS });

  return c.json({ data: [] });
});

export default app;
