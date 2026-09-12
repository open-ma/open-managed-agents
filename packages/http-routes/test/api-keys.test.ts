import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  buildApiKeyRoutes,
  type ApiKeyRecord,
  type ApiKeyStorage,
} from "../src/api-keys/index";

describe("environment service keys", () => {
  it("mints a Bearer-only key scoped to one environment", async () => {
    const inserted: Array<{ record: ApiKeyRecord; prefix: string }> = [];
    const storage: ApiKeyStorage = {
      insert: vi.fn(async ({ record, prefix }) => {
        inserted.push({ record, prefix });
      }),
      listByTenant: vi.fn(async () => []),
      findByHash: vi.fn(async () => null),
      deleteById: vi.fn(async () => false),
    };
    const routes = buildApiKeyRoutes({ storage });
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("tenant_id", "workspace_01");
      context.set("user_id", "user_01");
      await next();
    });
    app.route("/", routes);

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "production worker",
        environment_id: "env_01",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { key: string };
    expect(body.key).toMatch(/^oma_env_/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.record).toMatchObject({
      tenant_id: "workspace_01",
      user_id: "user_01",
      credential: { type: "environment", environmentId: "env_01" },
    });
    expect(inserted[0]?.prefix).toBe(body.key.slice(0, 12));
  });
});
