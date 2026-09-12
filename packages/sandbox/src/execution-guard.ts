import type { ProcessHandle, SandboxPort } from "./ports";

/**
 * The minimum authority a sandbox call needs from its parent execution.
 *
 * This intentionally does not import SessionExecutionFence.  Sandbox
 * providers are reusable by Node, Cloudflare and self-hosted hosts; the
 * session-runtime package owns the durable fence while this package only
 * enforces the local, synchronous boundary.
 */
export interface SandboxExecutionGuard {
  signal?: AbortSignal;
  /** Optional fast check for lease expiry or a provider-specific revocation. */
  isValid?: () => boolean;
}

export class SandboxExecutionFencedError extends Error {
  override readonly name = "SandboxExecutionFencedError";

  constructor(reason = "sandbox execution fence is no longer valid") {
    super(reason);
  }
}

const SAFE_METHODS = new Set([
  "runtimeHandle",
  "runtimeCapabilities",
  "status",
  "capabilities",
  "inspect",
  "sessionOutputMountCapabilities",
  "registerCommandSecrets",
]);

function assertValid(guard: SandboxExecutionGuard): void {
  if (guard.signal?.aborted) {
    throw new SandboxExecutionFencedError(
      guard.signal.reason instanceof Error
        ? guard.signal.reason.message
        : "sandbox execution was aborted",
    );
  }
  if (guard.isValid && !guard.isValid()) {
    throw new SandboxExecutionFencedError();
  }
}

async function invokeWithGuard<T>(
  guard: SandboxExecutionGuard,
  operation: () => Promise<T>,
): Promise<T> {
  assertValid(guard);
  const operationPromise = Promise.resolve().then(operation);
  if (!guard.signal) {
    const result = await operationPromise;
    assertValid(guard);
    return result;
  }

  let onAbort!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SandboxExecutionFencedError(
      guard.signal?.reason instanceof Error
        ? guard.signal.reason.message
        : "sandbox execution was aborted",
    ));
    guard.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([operationPromise, abortPromise]);
    assertValid(guard);
    return result;
  } finally {
    guard.signal.removeEventListener("abort", onAbort);
    // A provider call cannot always be cancelled (e.g. a remote HTTP
    // request). Observe its eventual rejection so losing a lease does not
    // create an unhandled rejection in the host.
    void operationPromise.catch(() => undefined);
  }
}

/**
 * Bind a sandbox instance to a session execution fence.
 *
 * Every method that can cross into provider/container state is guarded,
 * including methods added by provider adapters in the future. Only
 * introspection and local secret registration are deliberately exempt.
 * Calls are checked both before and after the provider operation; a result
 * that arrives after lease loss is therefore never handed to the harness.
 * A long-lived ProcessHandle is also terminated on abort so a stale hand
 * cannot continue mutating the workspace after its parent lost authority.
 */
export function withSandboxExecutionGuard<T extends SandboxPort>(
  sandbox: T,
  guard: SandboxExecutionGuard,
): T {
  return new Proxy(sandbox, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const name = String(property);
      if (SAFE_METHODS.has(name)) return value.bind(target);
      return (...args: unknown[]) => invokeWithGuard(
        guard,
        async () => {
          const result = await (value as (...input: unknown[]) => unknown).apply(target, args);
          if (name === "startProcess" && result && typeof result === "object") {
            const process = result as ProcessHandle;
            if (typeof process.kill === "function" && guard.signal) {
              const kill = () => {
                void process.kill("SIGTERM").catch(() => undefined);
              };
              if (guard.signal.aborted) kill();
              else guard.signal.addEventListener("abort", kill, { once: true });
            }
          }
          return result;
        },
      );
    },
  }) as T;
}

