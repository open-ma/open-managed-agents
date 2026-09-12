import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@fly/sprites", () => { throw new Error("module missing"); });

const previousToken = process.env.SPRITES_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.SPRITES_TOKEN;
  else process.env.SPRITES_TOKEN = previousToken;
});

function acquisition() {
  const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
  return {
    scope,
    fence: { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" },
    plan: {
      workspaceStrategy: "retained_runtime" as const,
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: { type: "ama_worker" as const, process: { command: "worker" } },
    },
    workspace: { bindingId: "workspace", mountPath: "/workspace" as const },
    outputs: null,
    credentialEgress: null,
    environment: {
      type: "base" as const,
      identity: "sprites:preinstalled",
      artifact: { type: "preinstalled" as const },
    },
    signal: new AbortController().signal,
  };
}

describe("Sprites optional SDK boundary", () => {
  it("rejects missing credentials before loading the provider SDK", async () => {
    delete process.env.SPRITES_TOKEN;
    const { createSpritesProvider } = await import("../src/sprites");
    await expect(createSpritesProvider({}).create(
      { sessionId: "session", workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toThrow("requires token or SPRITES_TOKEN");
  });

  it("reports the missing optional peer dependency after accepting an environment token", async () => {
    process.env.SPRITES_TOKEN = "environment-token";
    const { createSpritesProvider } = await import("../src/sprites");
    await expect(createSpritesProvider({}).create(
      { sessionId: "session", workdir: "/workspace" }, {}, acquisition(),
    )).rejects.toThrow("requires '@fly/sprites'");
  });
});
