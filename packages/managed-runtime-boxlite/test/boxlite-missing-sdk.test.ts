import { describe, expect, it, vi } from "vitest";

vi.mock("@boxlite-ai/boxlite", () => { throw new Error("missing module"); });

describe("BoxLite optional SDK failure", () => {
  it("explains how to install the optional peer", async () => {
    const { createBoxLiteProvider } = await import("../src/boxlite");
    const provider = createBoxLiteProvider({ providerId: "litebox", image: "image" });
    await expect(provider.create({ sessionId: "session", workdir: "/workspace" }, {}, {
      scope: { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" },
      fence: {
        workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work",
        ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z",
      },
      plan: {
        workspaceStrategy: "retained_runtime", outputStrategy: null, runtimeCheckpoint: null,
        driver: { type: "ama_worker", process: { command: "worker" } },
      },
      workspace: { bindingId: "workspace", mountPath: "/workspace" },
      outputs: null,
      credentialEgress: null,
      signal: new AbortController().signal,
    })).rejects.toThrow("requires '@boxlite-ai/boxlite'");
  });
});
