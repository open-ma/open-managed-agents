import { describe, it, expect } from "vitest";
import {
  validateAgentLimits,
  validateEnvironmentLimits,
} from "../../apps/main/src/lib/limits";

describe("validateAgentLimits", () => {
  it("accepts a fully empty patch (every field undefined)", () => {
    expect(validateAgentLimits({})).toEqual({ ok: true });
  });

  it("accepts a typical agent under all caps", () => {
    expect(
      validateAgentLimits({
        name: "My Agent",
        description: "Does things",
        system: "You are helpful.",
        tools: [{}, {}],
        mcp_servers: [{}],
        skills: [{}],
        metadata: { source: "console", region: "us" },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects name > 256 chars", () => {
    const r = validateAgentLimits({ name: "a".repeat(257) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name length 257 exceeds 256/);
  });

  it("rejects description > 2048 chars", () => {
    const r = validateAgentLimits({ description: "a".repeat(2049) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/description.*exceeds 2048/);
  });

  it("accepts description at exactly 2048", () => {
    expect(validateAgentLimits({ description: "a".repeat(2048) })).toEqual({
      ok: true,
    });
  });

  it("rejects system > 100,000 chars", () => {
    const r = validateAgentLimits({ system: "a".repeat(100_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/system length 100001 exceeds 100000/);
  });

  it("accepts system at exactly 100,000", () => {
    expect(validateAgentLimits({ system: "a".repeat(100_000) })).toEqual({
      ok: true,
    });
  });

  it("accepts system: null (clearing the field)", () => {
    expect(validateAgentLimits({ system: null })).toEqual({ ok: true });
  });

  it("rejects tools > 128 entries", () => {
    const r = validateAgentLimits({
      tools: Array.from({ length: 129 }, () => ({})),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tools length 129 exceeds 128/);
  });

  it("rejects mcp_servers > 20 entries", () => {
    const r = validateAgentLimits({
      mcp_servers: Array.from({ length: 21 }, () => ({})),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mcp_servers length 21 exceeds 20/);
  });

  it("rejects skills > 20 entries", () => {
    const r = validateAgentLimits({
      skills: Array.from({ length: 21 }, () => ({})),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/skills length 21 exceeds 20/);
  });

  it("rejects metadata > 16 keys", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 17; i++) meta[`k${i}`] = "v";
    const r = validateAgentLimits({ metadata: meta });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/metadata has 17 keys/);
  });

  it("rejects metadata key > 64 chars", () => {
    const r = validateAgentLimits({
      metadata: { ["k".repeat(65)]: "v" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/key length 65 exceeds 64/);
  });

  it("rejects metadata string value > 512 chars", () => {
    const r = validateAgentLimits({
      metadata: { source: "v".repeat(513) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/value length 513 exceeds 512/);
  });

  it("rejects metadata non-string value whose JSON serialization > 512 chars", () => {
    const big = { nested: "v".repeat(550) };
    const r = validateAgentLimits({ metadata: { source: big } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/value length \d+ exceeds 512/);
  });

  it("rejects metadata that is not an object", () => {
    const r = validateAgentLimits({
      metadata: ["a", "b"] as unknown as Record<string, unknown>,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/metadata must be an object/);
  });
});

describe("validateEnvironmentLimits", () => {
  it("accepts a typical env under all caps", () => {
    expect(
      validateEnvironmentLimits({
        name: "py-data",
        description: "Python sandbox",
        config: {
          type: "cloud",
          packages: { pip: ["pandas", "numpy"], npm: [] },
        },
        metadata: { team: "ml" },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects config.dockerfile > 100,000 chars", () => {
    const r = validateEnvironmentLimits({
      config: { type: "cloud", dockerfile: "a".repeat(100_001) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dockerfile length 100001 exceeds 100000/);
  });

  it("rejects packages.pip > 100 entries", () => {
    const r = validateEnvironmentLimits({
      config: {
        type: "cloud",
        packages: { pip: Array.from({ length: 101 }, (_, i) => `p${i}`) },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/packages.pip length 101 exceeds 100/);
  });

  it("rejects packages.npm > 100 entries (any ecosystem)", () => {
    const r = validateEnvironmentLimits({
      config: {
        type: "cloud",
        packages: { npm: Array.from({ length: 101 }, (_, i) => `p${i}`) },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/packages.npm length 101 exceeds 100/);
  });

  it("rejects metadata >16 keys (shared rule)", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 17; i++) meta[`k${i}`] = "v";
    const r = validateEnvironmentLimits({ metadata: meta });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/17 keys/);
  });

  it("ignores undefined config (PATCH that doesn't touch config)", () => {
    expect(validateEnvironmentLimits({ name: "x" })).toEqual({ ok: true });
  });
});
