import type {
  ManagedEnvironmentWorkDispatchPort,
} from "@open-managed-agents/managed-runtime-host";

export interface GkeSessionClaim {
  claimId: string;
  dispatchCount: number;
  workId?: string;
}

/** Structural boundary implemented by either a Kubernetes SDK adapter or an
 * OpenMA-owned in-cluster driver service. No Kubernetes dependency leaks here. */
export interface GkeSandboxClaimControlPlanePort {
  listSessionClaims(input: {
    namespace: string;
    environmentId: string;
    sessionId: string;
  }): Promise<readonly GkeSessionClaim[]>;
  deleteClaim(input: { namespace: string; claimId: string }): Promise<void>;
  createClaim(input: {
    namespace: string;
    /** Must atomically get-or-create one SandboxClaim for this key. */
    idempotencyKey: string;
    template: string;
    warmPool: string;
    labels: Readonly<Record<string, string>>;
    readyTimeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ claimId: string; dispatchUrl: string; created: boolean }>;
  postSession(input: {
    dispatchUrl: string;
    sessionId: string;
    workId: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface GkeManagedWorkControlPort {
  stop(input: {
    environmentId: string;
    workId: string;
    force: boolean;
  }): Promise<void>;
}

export interface GkeManagedEnvironmentDispatchOptions {
  controlPlane: GkeSandboxClaimControlPlanePort;
  workControl: GkeManagedWorkControlPort;
  namespace: string;
  template: string;
  warmPool: string;
  readyTimeoutMs?: number;
  maxRedispatch?: number;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

/** GKE Agent Sandbox lifecycle from the provider reference: reserve Work in
 * the dispatcher, reap stale SandboxClaims, bind one warm pod, then send only
 * the Session/Work ids. The in-pod `ant beta:worker run` owns Work ACK,
 * heartbeat and stop. */
export function createManagedEnvironmentWorkDispatchPort(
  factoryOptions: GkeManagedEnvironmentDispatchOptions,
): ManagedEnvironmentWorkDispatchPort {
  const options = factoryOptions;
  if (typeof options !== "object" || options === null) {
    throw new TypeError("GKE dispatch options are required");
  }
  if (
    typeof options.controlPlane?.listSessionClaims !== "function"
    || typeof options.controlPlane.deleteClaim !== "function"
    || typeof options.controlPlane.createClaim !== "function"
    || typeof options.controlPlane.postSession !== "function"
  ) {
    throw new TypeError("GKE dispatch requires a SandboxClaim control-plane Port");
  }
  if (typeof options.workControl?.stop !== "function") {
    throw new TypeError("GKE dispatch requires a Work control Port");
  }
  const namespace = nonEmpty(options.namespace, "namespace");
  const template = nonEmpty(options.template, "template");
  const warmPool = nonEmpty(options.warmPool, "warmPool");
  const readyTimeoutMs = positiveInteger(
    options.readyTimeoutMs ?? 120_000,
    "readyTimeoutMs",
  );
  const maxRedispatch = positiveInteger(
    options.maxRedispatch ?? 3,
    "maxRedispatch",
  );

  return {
    descriptor() {
      return {
        provider: "gke-agent-sandbox",
        version: "1.0.0",
        strategy: "poll_unacked_then_dispatch",
      };
    },

    async dispatch(input) {
      if (input.work.data.type !== "session") {
        throw new Error("GKE dispatcher only accepts Session Work");
      }
      input.signal.throwIfAborted();
      const sessionId = input.work.data.id;
      const stale = await options.controlPlane.listSessionClaims({
        namespace,
        environmentId: input.work.environment_id,
        sessionId,
      });
      let previousDispatchCount = 0;
      let survivingDispatchCount: number | undefined;
      for (const claim of stale) {
        if (!Number.isSafeInteger(claim.dispatchCount) || claim.dispatchCount < 0) {
          throw new Error(`GKE claim ${claim.claimId} has an invalid dispatch count`);
        }
        if (claim.workId === input.work.id) {
          survivingDispatchCount = Math.max(
            survivingDispatchCount ?? 0,
            claim.dispatchCount,
          );
          continue;
        }
        previousDispatchCount = Math.max(previousDispatchCount, claim.dispatchCount);
        await options.controlPlane.deleteClaim({ namespace, claimId: claim.claimId });
      }
      const dispatchCount = survivingDispatchCount ?? previousDispatchCount + 1;
      if (dispatchCount > maxRedispatch) {
        await options.workControl.stop({
          environmentId: input.work.environment_id,
          workId: input.work.id,
          force: true,
        });
        return;
      }

      input.signal.throwIfAborted();
      const bound = await options.controlPlane.createClaim({
        namespace,
        idempotencyKey: `${input.work.id}:${dispatchCount}`,
        template,
        warmPool,
        labels: {
          "openma.environment-id": input.work.environment_id,
          "openma.session-id": sessionId,
          "openma.work-id": input.work.id,
          "openma.dispatch-count": String(dispatchCount),
        },
        readyTimeoutMs,
        signal: input.signal,
      });
      try {
        await options.controlPlane.postSession({
          dispatchUrl: bound.dispatchUrl,
          sessionId,
          workId: input.work.id,
          signal: input.signal,
        });
      } catch (error) {
        if (bound.created) {
          await options.controlPlane.deleteClaim({
            namespace,
            claimId: bound.claimId,
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
