import { describe, expect, it } from "vitest";

import * as testingModule from "../src/testing";

const scope = {
  workspaceId: "workspace_1",
  environmentId: "environment_1",
  sessionId: "session_1",
  workId: "work_1",
};

function memoryFenceStore(clock: { now: number }) {
  const Constructor = (testingModule as Record<string, unknown>)[
    "MemoryRuntimeResourceFencePort"
  ];
  expect(Constructor).toBeTypeOf("function");
  return new (Constructor as new (options: unknown) => any)({
    now: () => new Date(clock.now),
    nextToken: (generation: number) => `token_${generation}`,
  });
}

describe("MemoryRuntimeResourceFencePort", () => {
  it("fences a stale owner after expiry and atomically rejects its publication", async () => {
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const store = memoryFenceStore(clock);
    const first = await store.acquire({
      scope,
      ownerId: "worker_old",
      ttlMs: 90_000,
    });
    expect(first.type).toBe("acquired");

    expect(
      await store.acquire({ scope, ownerId: "worker_new", ttlMs: 90_000 }),
    ).toMatchObject({ type: "conflict" });

    clock.now += 90_001;
    const second = await store.acquire({
      scope,
      ownerId: "worker_new",
      ttlMs: 90_000,
    });
    expect(second).toMatchObject({
      type: "acquired",
      fence: { generation: 2, ownerId: "worker_new" },
    });

    const candidates = {
      workspaceCandidate: { id: "workspace-old", contentHash: "sha256:old" },
      outputCandidate: { id: "outputs-old", contentHash: "sha256:old-output" },
    };
    await expect(
      store.publish({ fence: first.fence, ...candidates }),
    ).resolves.toEqual({ type: "lost" });
    await expect(
      store.publish({
        fence: second.fence,
        workspaceCandidate: {
          id: "workspace-new",
          contentHash: "sha256:new",
        },
        outputCandidate: {
          id: "outputs-new",
          contentHash: "sha256:new-output",
        },
      }),
    ).resolves.toEqual({ type: "published", revision: 1 });

    expect(store.inspect(scope)).toMatchObject({
      generation: 2,
      publication: {
        revision: 1,
        workspaceCandidate: { id: "workspace-new" },
        outputCandidate: { id: "outputs-new" },
      },
    });
  });

  it("makes acquire and publication retries idempotent", async () => {
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const store = memoryFenceStore(clock);
    const first = await store.acquire({
      scope,
      ownerId: "worker_1",
      ttlMs: 90_000,
    });
    const retried = await store.acquire({
      scope,
      ownerId: "worker_1",
      ttlMs: 90_000,
    });
    expect(retried).toEqual(first);

    const publication = {
      fence: first.fence,
      workspaceCandidate: { id: "workspace-1", contentHash: "sha256:one" },
      outputCandidate: null,
    };
    await expect(store.publish(publication)).resolves.toEqual({
      type: "published",
      revision: 1,
    });
    await expect(store.publish(publication)).resolves.toEqual({
      type: "published",
      revision: 1,
    });
  });

  it("invalidates the fence immediately on release", async () => {
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const store = memoryFenceStore(clock);
    const acquired = await store.acquire({
      scope,
      ownerId: "worker_1",
      ttlMs: 90_000,
    });
    await store.release({ fence: acquired.fence, reason: "failed" });

    await expect(
      store.renew({ fence: acquired.fence, ttlMs: 90_000 }),
    ).resolves.toEqual({ type: "lost" });
    await expect(
      store.publish({
        fence: acquired.fence,
        workspaceCandidate: { id: "late", contentHash: "sha256:late" },
        outputCandidate: null,
      }),
    ).resolves.toEqual({ type: "lost" });
  });

  it("returns the last atomically published candidates to the next owner", async () => {
    const clock = { now: Date.parse("2026-09-03T00:00:00.000Z") };
    const store = memoryFenceStore(clock);
    const first = await store.acquire({ scope, ownerId: "worker_1", ttlMs: 90_000 });
    await store.publish({
      fence: first.fence,
      workspaceCandidate: { id: "workspace-1", contentHash: "sha256:one" },
      outputCandidate: { id: "outputs-1", contentHash: "sha256:outputs" },
    });
    await store.release({ fence: first.fence, reason: "completed" });

    const second = await store.acquire({ scope, ownerId: "worker_2", ttlMs: 90_000 });
    expect(second).toMatchObject({
      type: "acquired",
      fence: { generation: 2 },
      publication: {
        revision: 1,
        workspaceCandidate: { id: "workspace-1" },
        outputCandidate: { id: "outputs-1" },
      },
    });
  });
});
