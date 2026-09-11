import { describe, expect, it, vi } from "vitest";

vi.mock("modal", () => { throw new Error("module missing"); });

describe("Modal optional SDK failure", () => {
  it("reports the peer dependency", async () => {
    const { createModalProvider } = await import("../src/modal");
    const provider = createModalProvider({
      appName: "app", image: "image", workspaceVolumeName: "workspace",
    });
    await expect(provider.create(
      { sessionId: "session", workdir: "/workspace" }, {},
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
        outputs: null, credentialEgress: null, signal: new AbortController().signal,
      },
    )).rejects.toThrow("requires 'modal'");
  });
});
