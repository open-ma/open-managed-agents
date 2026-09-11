import { beforeEach, describe, expect, it } from "vitest";

import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  ensureManagedEnvironmentActivationSchema,
  SqlManagedEnvironmentActivationIntentStore,
} from "../src/index";

const intent = {
  eventId: "event_01",
  environmentId: "env_01",
  sessionId: "session_01",
  workspaceId: "workspace_01",
};

const boundedIntent = {
  ...intent,
  maxAttempts: 3,
  deadlineAtMs: 100_000,
};

describe("SQL Managed Environment activation intent store", () => {
  let sql: SqlClient;
  let now: number;
  let store: SqlManagedEnvironmentActivationIntentStore;

  beforeEach(async () => {
    sql = await createBetterSqlite3SqlClient(":memory:");
    await ensureManagedEnvironmentActivationSchema(sql);
    now = 1_000;
    store = new SqlManagedEnvironmentActivationIntentStore(sql, {
      now: () => now,
      nextToken: (generation) => `token_${generation}`,
    });
  });

  it("inserts by webhook event id, preserves the first identity, and rejects collisions", async () => {
    await expect(store.enqueue(boundedIntent)).resolves.toEqual({ type: "inserted" });
    await expect(store.enqueue(boundedIntent)).resolves.toEqual({ type: "existing" });
    await expect(store.enqueue({ ...boundedIntent, sessionId: "session_collision" }))
      .rejects.toThrow(/event_01.*different activation/i);
  });

  it("leases one launch atomically and fences a stale generation", async () => {
    await store.enqueue(boundedIntent);
    const first = await store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_a",
      leaseTtlMs: 30,
      eventId: "event_01",
    });
    expect(first).toMatchObject({
      type: "claimed",
      claim: {
        generation: 1,
        ownerId: "launcher_a",
        token: "token_1",
        intent: { attemptCount: 1 },
      },
    });
    await expect(store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_b",
      leaseTtlMs: 30,
      eventId: "event_01",
    })).resolves.toEqual({ type: "empty" });

    now = 1_030;
    const replacement = await store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_b",
      leaseTtlMs: 30,
      eventId: "event_01",
    });
    expect(replacement).toMatchObject({
      type: "claimed",
      claim: {
        generation: 2,
        ownerId: "launcher_b",
        token: "token_2",
        intent: { attemptCount: 2 },
      },
    });
    if (first.type !== "claimed" || replacement.type !== "claimed") {
      throw new Error("expected claims");
    }
    await expect(store.complete({ claim: first.claim, runtimeId: "stale" }))
      .resolves.toEqual({ type: "lost" });
    await expect(store.complete({ claim: replacement.claim, runtimeId: "microvm_02" }))
      .resolves.toEqual({ type: "completed" });
    await expect(store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_c",
      leaseTtlMs: 30,
      eventId: "event_01",
    })).resolves.toEqual({ type: "empty" });
  });

  it("renews only the current launch generation while its total deadline is live", async () => {
    await store.enqueue(boundedIntent);
    const acquired = await store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_a",
      leaseTtlMs: 30,
      eventId: "event_01",
    });
    if (acquired.type !== "claimed") throw new Error("expected a claim");

    now = 1_010;
    const renewed = await store.renew({ claim: acquired.claim, leaseTtlMs: 30 });
    expect(renewed).toMatchObject({
      type: "renewed",
      claim: { generation: 1, expiresAtMs: 1_040 },
    });
    await expect(store.renew({
      claim: { ...acquired.claim, token: "stale" },
      leaseTtlMs: 30,
    })).resolves.toEqual({ type: "lost" });
  });

  it("releases failures with backoff and stops offering exhausted intents", async () => {
    await store.enqueue({
      ...intent,
      maxAttempts: 2,
      deadlineAtMs: 100_000,
    });
    const first = await store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_a",
      leaseTtlMs: 30,
    });
    if (first.type !== "claimed") throw new Error("expected a claim");
    await expect(store.retry({
      claim: first.claim,
      nextAttemptAtMs: 1_050,
      error: "RunMicrovm unavailable",
    })).resolves.toEqual({ type: "released" });

    now = 1_049;
    await expect(store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_b",
      leaseTtlMs: 30,
    })).resolves.toEqual({ type: "empty" });
    now = 1_050;
    const second = await store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_b",
      leaseTtlMs: 30,
    });
    expect(second).toMatchObject({ type: "claimed", claim: { intent: { attemptCount: 2 } } });
    if (second.type !== "claimed") throw new Error("expected second claim");
    now = second.claim.expiresAtMs;
    await expect(store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_c",
      leaseTtlMs: 30,
    })).resolves.toEqual({ type: "empty" });
  });

  it("persists the retry budget and deadline, then terminally exhausts expired intents", async () => {
    await store.enqueue({
      ...intent,
      maxAttempts: 2,
      deadlineAtMs: 1_020,
    });
    await expect(sql.prepare(`
      SELECT max_attempts, deadline_at_ms
      FROM managed_environment_activation_intents
      WHERE event_id = ?
    `).bind(intent.eventId).first()).resolves.toEqual({
      max_attempts: 2,
      deadline_at_ms: 1_020,
    });

    now = 1_020;
    await expect(store.claim({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      ownerId: "launcher_a",
      leaseTtlMs: 30,
      eventId: "event_01",
    })).resolves.toEqual({ type: "empty" });
    await expect(sql.prepare(`
      SELECT state, last_error
      FROM managed_environment_activation_intents
      WHERE event_id = ?
    `).bind(intent.eventId).first()).resolves.toEqual({
      state: "exhausted",
      last_error: "activation deadline exceeded",
    });
  });
});
