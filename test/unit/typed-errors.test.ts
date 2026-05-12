// Unit tests for the typed error class hierarchy + classifyExternalError
// heuristic mapper (packages/shared/src/errors.ts).
//
// Replaces the brittle TRANSIENT/FATAL substring allowlists previously
// inline in apps/agent/src/runtime/session-do.ts:processUserMessage.
// See commit 30e162b for the prior shape.

import { describe, it, expect } from "vitest";
import {
  AuthError,
  BillingError,
  ConfigError,
  NetworkError,
  OmaError,
  RateLimitedError,
  TransientInfraError,
  classifyExternalError,
} from "@open-managed-agents/shared";

describe("classifyExternalError", () => {
  it("maps CF 'version rollout' to TransientInfraError (the motivating case)", () => {
    const native = new Error(
      "Runtime signalled the container to exit due to a new version rollout: 0",
    );
    const out = classifyExternalError(native);
    expect(out).toBeInstanceOf(TransientInfraError);
    expect(out).toBeInstanceOf(OmaError);
    // Message preserved verbatim so existing log dashboards still work.
    expect((out as Error).message).toBe(native.message);
  });

  it("maps 'rate limit exceeded' to RateLimitedError", () => {
    const native = new Error("rate limit exceeded for tier free");
    const out = classifyExternalError(native);
    expect(out).toBeInstanceOf(RateLimitedError);
  });

  it("maps 'Insufficient balance' to BillingError", () => {
    const native = new Error("Insufficient balance: top up at /billing");
    const out = classifyExternalError(native);
    expect(out).toBeInstanceOf(BillingError);
  });

  it("returns unclassified errors unchanged", () => {
    const native = new Error("totally bogus thing happened in the foobar");
    const out = classifyExternalError(native);
    // Identity comparison — the wrapper falls through to caller.
    expect(out).toBe(native);
    expect(out).not.toBeInstanceOf(OmaError);
  });

  it("preserves the original error as `cause` on wrapped errors", () => {
    const native = new Error("fetch failed");
    const out = classifyExternalError(native);
    expect(out).toBeInstanceOf(NetworkError);
    expect((out as NetworkError).cause).toBe(native);
  });

  it("is idempotent — already-typed OmaError passes through unchanged", () => {
    const typed = new BillingError("wallet empty");
    const out = classifyExternalError(typed);
    expect(out).toBe(typed);
  });

  it("maps auth-shaped messages to AuthError", () => {
    expect(classifyExternalError(new Error("Unauthorized"))).toBeInstanceOf(AuthError);
    expect(classifyExternalError(new Error("403 Forbidden"))).toBeInstanceOf(AuthError);
  });

  it("maps config-shaped 'not found' to ConfigError", () => {
    expect(classifyExternalError(new Error("Agent not found: agt_x"))).toBeInstanceOf(
      ConfigError,
    );
    expect(classifyExternalError(new Error("Environment not found: env_x"))).toBeInstanceOf(
      ConfigError,
    );
  });

  it("maps 503 / Service Unavailable to TransientInfraError", () => {
    expect(classifyExternalError(new Error("503 Service Unavailable"))).toBeInstanceOf(
      TransientInfraError,
    );
  });

  it("maps fetch failed / ECONNREFUSED / timeout to NetworkError", () => {
    expect(classifyExternalError(new Error("fetch failed"))).toBeInstanceOf(NetworkError);
    expect(classifyExternalError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBeInstanceOf(
      NetworkError,
    );
    expect(classifyExternalError(new Error("request timeout after 30s"))).toBeInstanceOf(
      NetworkError,
    );
  });

  it("handles non-Error inputs (string / null / number)", () => {
    // Non-Error: stringified for matching, returned as-is when unmatched.
    expect(classifyExternalError("rate limit hit")).toBeInstanceOf(RateLimitedError);
    const sym = Symbol("opaque");
    expect(classifyExternalError(sym)).toBe(sym);
  });
});

describe("OmaError hierarchy", () => {
  it("constructor.name is the subclass name (not 'Error')", () => {
    expect(new TransientInfraError("x").name).toBe("TransientInfraError");
    expect(new BillingError("x").name).toBe("BillingError");
    expect(new ConfigError("x").name).toBe("ConfigError");
  });

  it("subclasses are all instanceof OmaError + instanceof Error", () => {
    const e = new RateLimitedError("x");
    expect(e).toBeInstanceOf(OmaError);
    expect(e).toBeInstanceOf(Error);
  });

  it("supports ES2022 cause via opts.cause", () => {
    const original = new Error("wire");
    const wrapped = new TransientInfraError("classified", { cause: original });
    expect((wrapped as { cause?: unknown }).cause).toBe(original);
  });
});
