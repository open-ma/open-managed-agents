import { describe, expect, it } from "vitest";

import {
  providePort,
  type PortToken,
} from "../../managed-agents-app/src/index";
import { httpClientPort } from "../../managed-agents-app/src/capabilities";
import {
  managedAgentsPortTokens,
} from "../../managed-agents-app/src/managed-agents";
import {
  createOpenMAApp,
} from "../../managed-agents-app/src/openma";
import {
  managedAgentsHttpHandlerPort,
  managedAgentsHttpModule,
  buildOmaModelsHttpRoutes,
  omaModelsHttpModule,
} from "../src/index";

describe("Managed Agents HTTP adapter module", () => {
  it("preinstalls the same credential-free Pi catalog route for platform entrypoints", async () => {
    const routes = buildOmaModelsHttpRoutes({
      fetch: async () => {
        throw new Error("provider credentials must not be proxied");
      },
    });

    const response = await routes.request("/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek-v4-flash",
          provider: "deepseek",
          api: "openai-completions",
        }),
      ]),
    });
  });

  it("mounts official and OMA model APIs without sharing their namespace", async () => {
    const model = {
      id: "claude-opus-5",
      allowedFallbackModels: null,
      capabilities: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      displayName: "Claude Opus 5",
      maxInputTokens: null,
      maxTokens: null,
    };
    const managedModules = Object.entries(managedAgentsPortTokens).map(
      ([name, token]) => providePort(
        token as PortToken<unknown>,
        name === "models"
          ? {
              listModels: async () => ({
                type: "page",
                page: { models: [model], hasMore: false },
              }),
              retrieveModel: async () => ({ type: "found", model }),
            }
          : { adapter: name },
      ),
    );
    const app = createOpenMAApp({
      modules: [
        ...managedModules,
        providePort(httpClientPort, {
          fetch: async () => {
            throw new Error("unexpected provider HTTP call");
          },
        }),
        omaModelsHttpModule(),
        managedAgentsHttpModule(),
      ],
    });
    const handler = app.port(managedAgentsHttpHandlerPort);

    const official = await handler.fetch(new Request("http://openma.test/v1/models"));
    expect(official.status).toBe(200);
    expect(await official.json()).toMatchObject({
      data: [{ id: "claude-opus-5", type: "model" }],
    });

    const oma = await handler.fetch(new Request(
      "http://openma.test/v1/oma/models/list",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "unknown", api_key: "unused" }),
      },
    ));
    expect(oma.status).toBe(200);
    expect(await oma.json()).toEqual({ data: [] });

    const collision = await handler.fetch(new Request(
      "http://openma.test/v1/models/list",
      { method: "POST" },
    ));
    expect(collision.status).toBe(404);
  });
});
