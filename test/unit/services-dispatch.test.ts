// Smoke tests for the integration of buildServices + STORE_BACKENDS dispatch.
//
// We don't have a real pg adapter wired in services/index.ts (Phase 4 of the
// per-tenant-D1 work intentionally only added the mechanism). What we CAN
// verify here:
//   - Default (no STORE_BACKENDS) returns a fully populated Services object
//     using the cf factories.
//   - Setting STORE_BACKENDS to route a store to "pg" trips the pickBackend
//     not-wired error (since no pg factory is registered yet) — confirming
//     the dispatch mechanism is actually consulting env.
//   - Setting STORE_BACKENDS to bogus JSON falls back to all-cf without
//     blowing up.
//
// When a real pg adapter is wired (uncommenting the pg: () => createPgX...
// line in services/index.ts), this file should be extended with a dispatch
// test that actually constructs the pg instance.

import { describe, it, expect } from "vitest";
import { buildCfServices } from "@open-managed-agents/services";
import type { Env } from "@open-managed-agents/shared";

const fakeDb = { __fake: "db" } as unknown as D1Database;

function envWith(extras: Record<string, string | undefined> = {}): Env {
  return {
    AUTH_DB: fakeDb,
    CONFIG_KV: {} as unknown,
    // Required by buildServices for at-rest encryption — value doesn't matter
    // for these tests since they don't actually run encrypt/decrypt.
    PLATFORM_ROOT_SECRET: "test-platform-root-secret-for-services-dispatch",
    ...extras,
  } as unknown as Env;
}

describe("buildServices — default cf wiring", () => {
  it("constructs every service when STORE_BACKENDS is unset", () => {
    const env = envWith();
    const services = buildCfServices(env, fakeDb);
    expect(services.agents).toBeDefined();
    expect(services.sessions).toBeDefined();
    expect(services.credentials).toBeDefined();
    expect(services.memory).toBeDefined();
    expect(services.vaults).toBeDefined();
    expect(services.files).toBeDefined();
    expect(services.evals).toBeDefined();
    expect(services.modelCards).toBeDefined();
    expect(services.environments).toBeDefined();
    expect(services.outboundSnapshots).toBeDefined();
    expect(services.sessionSecrets).toBeDefined();
    expect(services.tenantShardDirectory).toBeDefined();
    expect(services.shardPool).toBeDefined();
  });

  it("ignores malformed STORE_BACKENDS — all stores still cf", () => {
    const env = envWith({ STORE_BACKENDS: "not-json" });
    const services = buildCfServices(env, fakeDb);
    expect(services.agents).toBeDefined();
  });
});

describe("buildServices — pg dispatch", () => {
  it("throws clear error when routing to pg without an adapter wired", () => {
    const env = envWith({ STORE_BACKENDS: '{"agents":"pg"}' });
    expect(() => buildCfServices(env, fakeDb)).toThrow(/agents.+pg.+no pg adapter/);
  });

  it("error message names the specific store key — easy to act on", () => {
    const env = envWith({ STORE_BACKENDS: '{"sessions":"pg"}' });
    expect(() => buildCfServices(env, fakeDb)).toThrow(/sessions/);
  });

  it("only the routed store throws — others would have constructed cf", () => {
    // agents → pg (throws), sessions → cf (would succeed). The throw fires
    // first because pickBackend executes during the object literal build, but
    // we can verify the message is about agents not sessions.
    const env = envWith({ STORE_BACKENDS: '{"agents":"pg","sessions":"cf"}' });
    expect(() => buildCfServices(env, fakeDb)).toThrow(/agents/);
  });

  it("memory backend dispatch — also throws when not wired", () => {
    const env = envWith({ STORE_BACKENDS: '{"vaults":"memory"}' });
    expect(() => buildCfServices(env, fakeDb)).toThrow(/vaults.+memory.+no memory adapter/);
  });
});
