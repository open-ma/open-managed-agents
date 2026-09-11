import { describe, expect, it, vi } from "vitest";

vi.mock("@superserve/sdk", () => { throw new Error("module missing"); });

describe("Superserve optional SDK boundary", () => {
  it("reports the missing optional peer dependency", async () => {
    const { createSuperserveProvider } = await import("../src/superserve");
    const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
    await expect(createSuperserveProvider({}).create(
      { sessionId: "session", workdir: "/workspace" }, {}, {
        scope,
        fence: { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2026-09-01T00:00:00.000Z" },
        plan: {
          workspaceStrategy: "retained_runtime", outputStrategy: null, runtimeCheckpoint: null,
          driver: { type: "ama_worker", process: { command: "worker" } },
        },
        workspace: { bindingId: "workspace", mountPath: "/workspace" },
        outputs: null, credentialEgress: null, signal: new AbortController().signal,
      },
    )).rejects.toThrow("requires '@superserve/sdk'");
  });
});
