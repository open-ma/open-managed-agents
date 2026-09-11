import { describe, expect, it, vi } from "vitest";

import {
  createManagedEnvironmentActivationPort,
  type AwsActivationClaim,
  type AwsActivationIntent,
  type AwsActivationIntentStorePort,
  type AwsManagedEnvironmentActivationOptions,
} from "../src/index";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _FactoryKeepsAwsConstructorOptions = Assert<Equal<
  Parameters<typeof createManagedEnvironmentActivationPort>[0],
  AwsManagedEnvironmentActivationOptions
>>;

class MemoryIntentStore implements AwsActivationIntentStorePort {
  readonly intents = new Map<string, AwsActivationIntent>();
  readonly completed = new Map<string, string>();
  readonly claims = new Map<string, AwsActivationClaim>();
  readonly generations = new Map<string, number>();
  renewCount = 0;
  now = 1_000;

  async enqueue(intent: Omit<AwsActivationIntent, "attemptCount" | "nextAttemptAtMs">) {
    if (this.intents.has(intent.eventId)) return { type: "existing" as const };
    this.intents.set(intent.eventId, {
      ...intent,
      attemptCount: 0,
      nextAttemptAtMs: this.now,
    });
    return { type: "inserted" as const };
  }

  async claim(input: {
    environmentId: string;
    workspaceId: string;
    ownerId: string;
    leaseTtlMs: number;
    eventId?: string;
  }) {
    const intent = [...this.intents.values()].find((candidate) =>
      candidate.environmentId === input.environmentId
      && candidate.workspaceId === input.workspaceId
      && (input.eventId === undefined || candidate.eventId === input.eventId)
      && !this.completed.has(candidate.eventId)
      && candidate.attemptCount < candidate.maxAttempts
      && candidate.deadlineAtMs > this.now
      && candidate.nextAttemptAtMs <= this.now
      && ((this.claims.get(candidate.eventId)?.expiresAtMs ?? 0) <= this.now));
    if (intent === undefined) return { type: "empty" as const };
    const generation = (this.generations.get(intent.eventId) ?? 0) + 1;
    this.generations.set(intent.eventId, generation);
    const claim: AwsActivationClaim = {
      intent: { ...intent, attemptCount: intent.attemptCount + 1 },
      ownerId: input.ownerId,
      generation,
      token: `token_${generation}`,
      expiresAtMs: this.now + input.leaseTtlMs,
    };
    this.intents.set(intent.eventId, claim.intent);
    this.claims.set(intent.eventId, claim);
    return { type: "claimed" as const, claim };
  }

  async complete(input: { claim: AwsActivationClaim; runtimeId: string }) {
    const current = this.claims.get(input.claim.intent.eventId);
    if (current?.token !== input.claim.token || current.expiresAtMs <= this.now) {
      return { type: "lost" as const };
    }
    this.completed.set(input.claim.intent.eventId, input.runtimeId);
    this.claims.delete(input.claim.intent.eventId);
    return { type: "completed" as const };
  }

  async renew(input: { claim: AwsActivationClaim; leaseTtlMs: number }) {
    const current = this.claims.get(input.claim.intent.eventId);
    if (current?.token !== input.claim.token || current.expiresAtMs <= this.now) {
      return { type: "lost" as const };
    }
    this.renewCount += 1;
    const claim = {
      ...current,
      expiresAtMs: Math.min(
        this.now + input.leaseTtlMs,
        current.intent.deadlineAtMs,
      ),
    };
    this.claims.set(input.claim.intent.eventId, claim);
    return { type: "renewed" as const, claim };
  }

  async retry(input: {
    claim: AwsActivationClaim;
    nextAttemptAtMs: number;
    error: string;
  }) {
    const current = this.claims.get(input.claim.intent.eventId);
    if (current?.token !== input.claim.token || current.expiresAtMs <= this.now) {
      return { type: "lost" as const };
    }
    this.intents.set(input.claim.intent.eventId, {
      ...input.claim.intent,
      nextAttemptAtMs: input.nextAttemptAtMs,
    });
    this.claims.delete(input.claim.intent.eventId);
    return {
      type: input.claim.intent.attemptCount >= input.claim.intent.maxAttempts
        || input.nextAttemptAtMs >= input.claim.intent.deadlineAtMs
        ? "exhausted" as const
        : "released" as const,
    };
  }
}

const activationInput = {
  eventId: "event_01",
  environmentId: "env_01",
  sessionId: "session_01",
  workspaceId: "workspace_01",
};

describe("AWS provider-native activation adapter", () => {
  it("always stops lease renewal when retry persistence itself fails", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryIntentStore();
      store.retry = async () => {
        throw new Error("activation store unavailable");
      };
      const port = createManagedEnvironmentActivationPort({
        store,
        launcher: {
          launch: vi.fn(async () => {
            throw new Error("RunMicrovm unavailable");
          }),
          destroy: vi.fn(async () => undefined),
        },
        ownerId: "launcher_01",
        leaseTtlMs: 30,
        leaseHeartbeatIntervalMs: 10,
        now: () => store.now,
      });

      await expect(port.activate(activationInput)).rejects.toThrow(
        /activation store unavailable/,
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(store.renewCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the activation fence while RunMicrovm is still pending", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryIntentStore();
      let finishLaunch!: (value: { runtimeId: string }) => void;
      const launch = vi.fn(() => new Promise<{ runtimeId: string }>((resolve) => {
        finishLaunch = resolve;
      }));
      const port = createManagedEnvironmentActivationPort({
        store,
        launcher: { launch, destroy: vi.fn(async () => undefined) },
        ownerId: "launcher_01",
        leaseTtlMs: 30,
        leaseHeartbeatIntervalMs: 10,
        now: () => store.now,
      });

      const activating = port.activate(activationInput);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10);
      expect(store.renewCount).toBeGreaterThanOrEqual(1);

      finishLaunch({ runtimeId: "microvm_slow" });
      await activating;
      expect(store.completed.get("event_01")).toBe("microvm_slow");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent webhook deliveries before launching a MicroVM", async () => {
    const store = new MemoryIntentStore();
    const launch = vi.fn(async () => ({ runtimeId: "microvm_01" }));
    const port = createManagedEnvironmentActivationPort({
      store,
      launcher: { launch, destroy: vi.fn(async () => undefined) },
      ownerId: "launcher_01",
      now: () => store.now,
    });

    await Promise.all([port.activate(activationInput), port.activate(activationInput)]);

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      activationId: "event_01",
      idempotencyKey: "event_01:1",
      sessionId: "session_01",
      attempt: 1,
    }));
    expect(store.completed.get("event_01")).toBe("microvm_01");
  });

  it("reconciles a durable intent after a transient launch failure", async () => {
    const store = new MemoryIntentStore();
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error("injected RunMicrovm failure"))
      .mockResolvedValueOnce({ runtimeId: "microvm_02" });
    const port = createManagedEnvironmentActivationPort({
      store,
      launcher: { launch, destroy: vi.fn(async () => undefined) },
      ownerId: "launcher_01",
      retryDelayMs: 50,
      now: () => store.now,
    });

    await expect(port.activate(activationInput)).rejects.toThrow(/RunMicrovm failure/);
    expect(store.completed.size).toBe(0);
    store.now += 50;

    await port.reconcile({
      environmentId: "env_01",
      workspaceId: "workspace_01",
      signal: new AbortController().signal,
    });

    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1]?.[0]).toMatchObject({
      activationId: "event_01",
      idempotencyKey: "event_01:2",
      attempt: 2,
    });
    expect(store.completed.get("event_01")).toBe("microvm_02");
  });

  it("destroys a launched orphan when the activation fence is lost before commit", async () => {
    const store = new MemoryIntentStore();
    const destroy = vi.fn(async () => undefined);
    const originalComplete = store.complete.bind(store);
    store.complete = async (input) => {
      store.now = input.claim.expiresAtMs;
      return originalComplete(input);
    };
    const port = createManagedEnvironmentActivationPort({
      store,
      launcher: {
        launch: async () => ({ runtimeId: "microvm_orphan" }),
        destroy,
      },
      ownerId: "launcher_01",
      now: () => store.now,
    });

    await expect(port.activate(activationInput)).rejects.toThrow(/activation fence/);

    expect(destroy).toHaveBeenCalledWith({
      runtimeId: "microvm_orphan",
      reason: "activation_fence_lost",
    });
    expect(store.completed.size).toBe(0);
  });
});
