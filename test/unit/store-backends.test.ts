// Unit tests for the storage backend dispatch mechanism.
//
// Pure functions, no D1 / pg / mocks needed. Covers:
//   - parseStoreBackends parsing (valid JSON, malformed, missing)
//   - pickBackend default cf, override, missing pg adapter error message
//   - error message includes the store key + backend name for debugging

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseStoreBackends,
  pickBackend,
  type StoreBackendName,
} from "@open-managed-agents/services";
import type { Env } from "@open-managed-agents/shared";

function envWith(STORE_BACKENDS?: string): Env {
  return { STORE_BACKENDS } as unknown as Env;
}

describe("parseStoreBackends", () => {
  it("returns empty object when env var unset", () => {
    expect(parseStoreBackends(envWith())).toEqual({});
  });

  it("parses valid JSON", () => {
    const result = parseStoreBackends(envWith('{"agents":"pg","sessions":"cf"}'));
    expect(result).toEqual({ agents: "pg", sessions: "cf" });
  });

  it("returns empty object on malformed JSON, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseStoreBackends(envWith("not-json"))).toEqual({});
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns empty object on JSON null / array (not an object)", () => {
    expect(parseStoreBackends(envWith("null"))).toEqual({});
    expect(parseStoreBackends(envWith("[]"))).toEqual({}); // arrays are objects but typeof is object — we accept both, ports won't lookup their keys
  });
});

describe("pickBackend", () => {
  it("defaults to cf when no override", () => {
    const cfFactory = vi.fn(() => "cf-instance");
    const pgFactory = vi.fn(() => "pg-instance");
    const result = pickBackend({}, "agents", { cf: cfFactory, pg: pgFactory });
    expect(result).toBe("cf-instance");
    expect(cfFactory).toHaveBeenCalledOnce();
    expect(pgFactory).not.toHaveBeenCalled();
  });

  it("uses pg when overridden and pg factory registered", () => {
    const cfFactory = vi.fn(() => "cf-instance");
    const pgFactory = vi.fn(() => "pg-instance");
    const result = pickBackend({ agents: "pg" }, "agents", {
      cf: cfFactory,
      pg: pgFactory,
    });
    expect(result).toBe("pg-instance");
    expect(pgFactory).toHaveBeenCalledOnce();
    expect(cfFactory).not.toHaveBeenCalled();
  });

  it("throws helpful error when pg requested but no pg factory wired", () => {
    expect(() =>
      pickBackend({ agents: "pg" }, "agents", {
        cf: () => "cf-instance",
      }),
    ).toThrow(/STORE_BACKENDS\["agents"\]="pg".+no pg adapter/);
  });

  it("only the specified store is overridden — others stay cf", () => {
    const overrides = { agents: "pg" as StoreBackendName };
    const sessionsCf = vi.fn(() => "sessions-cf");
    const sessionsPg = vi.fn(() => "sessions-pg");
    const result = pickBackend(overrides, "sessions", {
      cf: sessionsCf,
      pg: sessionsPg,
    });
    expect(result).toBe("sessions-cf");
    expect(sessionsPg).not.toHaveBeenCalled();
  });

  it("supports memory backend (3rd registered factory)", () => {
    const result = pickBackend({ agents: "memory" }, "agents", {
      cf: () => "cf",
      memory: () => "memory-instance",
    });
    expect(result).toBe("memory-instance");
  });
});
