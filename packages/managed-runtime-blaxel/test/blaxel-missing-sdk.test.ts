import { describe, expect, it, vi } from "vitest";

vi.mock("@blaxel/core", () => {
  throw new Error("module unavailable");
});

describe("Blaxel optional SDK failure", () => {
  it("reports a useful missing-peer error", async () => {
    const { createBlaxelProvider } = await import("../src/blaxel");
    const provider = createBlaxelProvider({ image: "image" });
    await expect(provider.create(
      { sessionId: "session", workdir: "/workspace" },
      {},
      {
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
        environment: {
          type: "base",
          identity: "image",
          artifact: { type: "image", reference: "image" },
        },
        signal: new AbortController().signal,
      },
    )).rejects.toThrow("requires '@blaxel/core'");
  });
});
