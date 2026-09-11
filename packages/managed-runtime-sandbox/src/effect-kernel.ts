import { Cause, Effect, Exit, Option } from "effect";

export function waitForAbortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wrap an interruptible Promise operation without changing its error value. */
export function tryPortPromise<A>(
  operation: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({
    try: operation,
    catch: (error) => error,
  });
}

/**
 * Run an internal Effect program behind the Promise-based Port boundary.
 * Effect's FiberFailure is intentionally not part of the public contract.
 */
export async function runPortEffect<A, E>(
  effect: Effect.Effect<A, E, never>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  if (signal?.aborted) throw signal.reason;
  throw Cause.squash(exit.cause);
}
