import type {
  ManagedEnvironmentWorkDispatchPort,
} from "@open-managed-agents/managed-runtime-host";

export type CloudflareManagedRuntimeBackend = "microvm" | "isolate";

/** A session-keyed Cloudflare runtime (Sandbox DO or Isolate runner DO).
 * The runtime owns the first heartbeat/ACK, lease, tool dispatch, restore
 * barrier, and egress policy. Calls must be idempotent for the same Work. */
export interface CloudflareManagedSessionRuntimePort {
  dispatch(input: {
    apiBaseUrl: string;
    environmentId: string;
    sessionId: string;
    workId: string;
    signal: AbortSignal;
  }): Promise<{ created: boolean }>;
}

export interface CloudflareManagedEnvironmentDispatchOptions {
  resolveBackend(input: {
    environmentId: string;
    sessionId: string;
    workId: string;
    workspaceId: string;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<CloudflareManagedRuntimeBackend | string>;
  getRuntime(input: {
    backend: CloudflareManagedRuntimeBackend;
    sessionId: string;
  }): CloudflareManagedSessionRuntimePort;
}

/** Cloudflare reference-control-plane projection. OpenMA reserves Work with
 * raw poll and routes it to a session-named runtime. Environment credentials
 * remain in the trusted Worker/DO binding and are never copied into Work or
 * session metadata. */
export function createManagedEnvironmentWorkDispatchPort(
  factoryOptions: CloudflareManagedEnvironmentDispatchOptions,
): ManagedEnvironmentWorkDispatchPort {
  const options = factoryOptions;
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Cloudflare dispatch options are required");
  }
  if (typeof options.resolveBackend !== "function") {
    throw new TypeError("Cloudflare dispatch requires a backend resolver");
  }
  if (typeof options.getRuntime !== "function") {
    throw new TypeError("Cloudflare dispatch requires a session runtime resolver");
  }

  return {
    descriptor() {
      return {
        provider: "cloudflare",
        version: "1.0.0",
        strategy: "poll_unacked_then_dispatch",
      };
    },

    async dispatch(input) {
      if (input.work.data.type !== "session") {
        throw new Error("Cloudflare dispatcher only accepts Session Work");
      }
      input.signal.throwIfAborted();
      const sessionId = input.work.data.id;
      const backend = await options.resolveBackend({
        environmentId: input.work.environment_id,
        sessionId,
        workId: input.work.id,
        workspaceId: input.workspaceId,
        metadata: input.work.metadata,
      });
      if (backend !== "microvm" && backend !== "isolate") {
        throw new Error(`unsupported Cloudflare backend: ${String(backend)}`);
      }
      input.signal.throwIfAborted();
      const runtime = options.getRuntime({ backend, sessionId });
      if (typeof runtime?.dispatch !== "function") {
        throw new TypeError("Cloudflare session runtime does not implement dispatch");
      }
      await runtime.dispatch({
        apiBaseUrl: input.apiBaseUrl,
        environmentId: input.work.environment_id,
        sessionId,
        workId: input.work.id,
        signal: input.signal,
      });
      input.signal.throwIfAborted();
    },
  };
}
