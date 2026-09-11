import { describe, expect, it } from "vitest";
import { ModelCardCatalogSource } from "../src";

const cards = [
  {
    id: "mcard_old",
    tenant_id: "tenant_a",
    model_id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    base_url: null,
    pi_config: null,
    created_at: "2026-08-01T00:00:00.000Z",
    archived_at: null,
  },
  {
    id: "mcard_new",
    tenant_id: "tenant_a",
    model_id: "openai/gpt-5.4",
    model: "gpt-5.4",
    provider: "openai",
    base_url: null,
    pi_config: null,
    created_at: "2026-08-02T00:00:00.000Z",
    archived_at: null,
  },
  {
    id: "mcard_archived",
    tenant_id: "tenant_a",
    model_id: "retired-model",
    model: "retired-model",
    provider: "anthropic",
    base_url: null,
    pi_config: null,
    created_at: "2026-08-03T00:00:00.000Z",
    archived_at: "2026-08-04T00:00:00.000Z",
  },
];

describe("ModelCardCatalogSource", () => {
  it("exposes only executable cards in Managed Agents model order", async () => {
    const listCalls: unknown[] = [];
    const source = new ModelCardCatalogSource({
      list: async (input) => {
        listCalls.push(input);
        return cards;
      },
      findByModelId: async ({ tenantId, modelId }) =>
        cards.find((card) =>
          card.tenant_id === tenantId && card.model_id === modelId
        ) ?? null,
    });

    await expect(source.list({ workspaceId: "tenant_a", limit: 10 }))
      .resolves.toEqual({
        type: "page",
        models: [
          {
            id: "openai/gpt-5.4",
            allowedFallbackModels: null,
            capabilities: expect.objectContaining({
              effort: expect.objectContaining({ supported: true }),
              imageInput: { supported: true },
              thinking: expect.objectContaining({ supported: true }),
            }),
            createdAt: "2026-08-02T00:00:00.000Z",
            displayName: "GPT-5.4",
            maxInputTokens: expect.any(Number),
            maxTokens: expect.any(Number),
          },
          {
            id: "claude-sonnet-4-6",
            allowedFallbackModels: null,
            capabilities: expect.objectContaining({
              effort: expect.objectContaining({ supported: true }),
              imageInput: { supported: true },
              thinking: expect.objectContaining({ supported: true }),
            }),
            createdAt: "2026-08-01T00:00:00.000Z",
            displayName: "Claude Sonnet 4.6",
            maxInputTokens: expect.any(Number),
            maxTokens: expect.any(Number),
          },
        ],
        hasMore: false,
      });
    await expect(source.find({
      workspaceId: "tenant_a",
      modelId: "retired-model",
    })).resolves.toBeNull();
    expect(listCalls).toEqual([{ tenantId: "tenant_a" }]);
  });
});
