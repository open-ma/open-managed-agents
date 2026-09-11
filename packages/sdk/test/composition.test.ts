import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";

import { OpenMA } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenMA SDK composition facade", () => {
  it("runs the Managed Agents lane through the exact official SDK beta resource", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      return jsonResponse({
        data: [{ id: "agent_facade", type: "agent", name: "Facade agent" }],
        next_page: null,
      });
    };

    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      activeTenantId: "tn_facade",
      maxRetries: 0,
      fetch: fetcher,
    });

    expect(client.anthropic).toBeInstanceOf(Anthropic);
    expect(client.beta).toBe(client.anthropic.beta);
    expectTypeOf(client.beta).toEqualTypeOf<Anthropic["beta"]>();

    const page = await client.beta.agents.list({ limit: 7 });

    expect(page.data).toEqual([
      { id: "agent_facade", type: "agent", name: "Facade agent" },
    ]);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url)).toMatchObject({
      origin: "https://openma.test",
      pathname: "/v1/agents",
      search: "?beta=true&limit=7",
    });
    expect(requests[0]!.headers.get("x-api-key")).toBe("oma_test_key");
    expect(requests[0]!.headers.get("x-active-tenant")).toBe("tn_facade");
    expect(requests[0]!.headers.get("anthropic-beta")).toContain(
      "managed-agents-2026-04-01",
    );
  });

  it("routes provider discovery through the OMA namespace with the shared official transport", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      return jsonResponse({
        data: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
      });
    };

    const client = new OpenMA({
      bearer: "console-session",
      baseUrl: "https://openma.test/",
      activeTenantId: "tn_console",
      maxRetries: 0,
      fetch: fetcher,
    });

    expect(client.oma).toBeDefined();
    const models = await client.oma.models.list({
      provider: "ant",
      apiKey: "sk-ant-provider",
    });

    expect(models).toEqual({
      data: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url)).toMatchObject({
      origin: "https://openma.test",
      pathname: "/v1/oma/models/list",
      search: "",
    });
    expect(await requests[0]!.json()).toEqual({
      provider: "ant",
      api_key: "sk-ant-provider",
    });
    expect(requests[0]!.headers.get("authorization")).toBe(
      "Bearer console-session",
    );
    expect(requests[0]!.headers.get("x-active-tenant")).toBe("tn_console");
  });

  it("uses Pi provider ids and does not require forwarding provider credentials", async () => {
    let captured: Request | undefined;
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        captured = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        return jsonResponse({ data: [] });
      },
    });

    await client.oma.models.list({ provider: "deepseek" });

    expect(await captured!.json()).toEqual({ provider: "deepseek" });
  });

  it("provides typed Model Card CRUD on the OMA lane", async () => {
    const requests: Request[] = [];
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        requests.push(request);
        return jsonResponse({
          id: "mcard_1",
          model_id: "deepseek-fast",
          model: "deepseek-v4-flash",
          provider: "deepseek",
          api_key_preview: "sk-...1234",
          pi_config: { reasoning: true },
          is_default: true,
          created_at: "2026-09-02T00:00:00.000Z",
          archived_at: null,
        }, request.method === "POST" && new URL(request.url).pathname.endsWith("model_cards") ? 201 : 200);
      },
    });
    const modelCards = client.oma.modelCards;

    expect(modelCards).toBeDefined();
    await modelCards.create({
      model_id: "deepseek-fast",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      api_key: "sk-tenant-secret",
      pi_config: { reasoning: true },
    });
    await modelCards.retrieve("mcard_1");
    await modelCards.update("mcard_1", { pi_config: { reasoning: false } });
    await modelCards.delete("mcard_1");

    expect(requests.map((request) => [request.method, new URL(request.url).pathname]))
      .toEqual([
        ["POST", "/v1/oma/model_cards"],
        ["GET", "/v1/oma/model_cards/mcard_1"],
        ["POST", "/v1/oma/model_cards/mcard_1"],
        ["DELETE", "/v1/oma/model_cards/mcard_1"],
      ]);
    expect(JSON.stringify(await requests[0]!.clone().json())).toContain(
      "deepseek-v4-flash",
    );
  });

  it("keeps official SDK errors on the OMA lane", async () => {
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      maxRetries: 0,
      fetch: async () => jsonResponse({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "api_key is required",
        },
        request_id: "req_oma",
      }, 400),
    });

    await expect(client.oma.models.list({
      provider: "ant",
      apiKey: "",
    })).rejects.toBeInstanceOf(Anthropic.BadRequestError);
  });

  it("preserves official Headers options while adding OpenMA defaults", async () => {
    let captured: Request | undefined;
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      activeTenantId: "tn_headers",
      defaultHeaders: new Headers([
        ["x-openma-custom", "custom-value"],
      ]),
      maxRetries: 0,
      fetch: async (input, init) => {
        captured = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        return jsonResponse({ data: [] });
      },
    });

    await client.oma.models.list({ provider: "oai", apiKey: "sk-provider" });

    expect(captured?.headers.get("x-openma-custom")).toBe("custom-value");
    expect(captured?.headers.get("x-active-tenant")).toBe("tn_headers");
  });

  it("offers an OMA-only request escape hatch on the shared transport", async () => {
    let captured: Request | undefined;
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      maxRetries: 0,
      fetch: async (input, init) => {
        captured = input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
        return jsonResponse({ model_cards: 3 });
      },
    });

    const stats = await client.oma.request<{ model_cards: number }>({
      method: "get",
      path: "/v1/oma/stats",
      query: { include_archived: false },
    });

    expect(stats).toEqual({ model_cards: 3 });
    expect(captured && new URL(captured.url)).toMatchObject({
      pathname: "/v1/oma/stats",
      search: "?include_archived=false",
    });
  });

  it("rejects Managed API paths from the OMA escape hatch", () => {
    const client = new OpenMA({
      apiKey: "oma_test_key",
      baseURL: "https://openma.test",
      fetch: async () => jsonResponse({}),
    });

    expect(() => client.oma.request({
      method: "get",
      path: "/v1/agents" as "/v1/oma/agents",
    })).toThrow("OpenMA extension requests must use /v1/oma/* paths");
  });
});
