import { describe, expect, it, vi } from "vitest";

vi.mock("@vercel/sandbox", () => { throw new Error("module missing"); });

describe("Vercel optional SDK boundary", () => {
  it("reports the missing optional peer dependency", async () => {
    const { createVercelProvider } = await import("../src/vercel");
    const scope = { workspaceId: "workspace", environmentId: "environment", sessionId: "session", workId: "work" };
    await expect(createVercelProvider({}).create(
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
    )).rejects.toThrow("requires '@vercel/sandbox'");
  });
});
