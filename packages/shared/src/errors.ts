// Typed error class hierarchy for OMA. Replaces brittle string-pattern
// error classification (see commit 30e162b's TRANSIENT/FATAL allowlists).
//
// Boundary wrappers around external SDK calls (CF Containers, model
// providers, billing meters) should re-throw native errors as instances
// of these classes via `classifyExternalError` (or by direct construction
// when the boundary has typed knowledge of the failure mode). The
// processUserMessage retry switch then operates on `instanceof` checks
// instead of substring matching — robust to vendor-side wording changes
// and net-new transient failure modes.
//
// Zero-dep design: this file is consumed by both CF Workers (DO) and
// Node runtimes — no node:* imports, no CF types. ES2022 `cause` is
// supported via a manual assign so we don't depend on tsconfig
// `target: ES2022` propagating through every consumer.

export class OmaError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    if (opts?.cause !== undefined) {
      // Direct assign instead of `super(message, { cause })` so we don't
      // require lib.es2022+. Most modern runtimes (Node 18+, recent
      // workerd) accept the second arg, but keeping this manual is the
      // portable form.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ─── Retryable (transient) — call site should retry once before giving up.
//
// These are infra / capacity / network conditions that re-running the
// turn can recover from. They include the CF rollout error that motivated
// this rewrite (mid-turn container kill on wrangler deploy).

/** CF rollout, container OOM, container restart, "Sandbox error" wrapper. */
export class TransientInfraError extends OmaError {}

/** 429 / 503 from a model provider, "rate limit exceeded", "quota exceeded". */
export class RateLimitedError extends OmaError {}

/** DNS, connection refused, fetch failed, request timeouts. */
export class NetworkError extends OmaError {}

/** LLM provider returned a non-2xx with no clearer signal (5xx, malformed). */
export class ModelError extends OmaError {}

// ─── Fatal — retry won't help, surface to user immediately.

/** Agent / environment / vault not found, mis-shaped config, missing field. */
export class ConfigError extends OmaError {}

/** Insufficient balance, plan limit hit, 402 from the billing meter. */
export class BillingError extends OmaError {}

/** 401 / 403 from a model provider or downstream auth gate. */
export class AuthError extends OmaError {}

/**
 * Heuristic mapper: native/external error → typed OmaError.
 *
 * Used by boundary wrappers when they don't have enough info to type the
 * error directly. Falls back to the original error if no pattern matches
 * — the caller decides whether to treat unclassified as transient (the
 * current `processUserMessage` policy is retry-by-default).
 *
 * If `err` is already an OmaError, it's returned as-is so wrappers can
 * compose without double-classification.
 */
export function classifyExternalError(err: unknown): OmaError | unknown {
  if (err instanceof OmaError) return err;
  const msg = err instanceof Error ? err.message : String(err);

  // CF Containers — the motivating case. "version rollout" is the exact
  // string CF emits when a wrangler deploy kills a container mid-turn;
  // "container to exit", "container is not listening", and the generic
  // "Sandbox error" wrapper all surface from the @cloudflare/sandbox SDK
  // when the underlying container fails for transient reasons.
  if (/version rollout|container to exit|container is not listening|Sandbox error/i.test(msg)) {
    return new TransientInfraError(msg, { cause: err });
  }

  // Rate limits + provider-side capacity exhaustion.
  if (/rate limit|429|quota exceeded/i.test(msg)) {
    return new RateLimitedError(msg, { cause: err });
  }
  if (/503|service unavailable|temporarily unavailable/i.test(msg)) {
    return new TransientInfraError(msg, { cause: err });
  }

  // Network — DNS, TCP, request timeouts.
  if (/timeout|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(msg)) {
    return new NetworkError(msg, { cause: err });
  }

  // Auth — model provider or downstream gate said no.
  if (/unauthorized|forbidden|401|403/i.test(msg)) {
    return new AuthError(msg, { cause: err });
  }

  // Billing — wallet empty, plan exhausted.
  if (/insufficient balance|payment required|402/i.test(msg)) {
    return new BillingError(msg, { cause: err });
  }

  // Config — missing entity in the system catalog. Match phrasing the
  // processUserMessage catch and main worker already use ("Agent not
  // found", "Environment not found", etc.).
  if (/(Agent|Environment|Vault) not found/i.test(msg)) {
    return new ConfigError(msg, { cause: err });
  }

  return err; // unclassified — let caller decide
}
