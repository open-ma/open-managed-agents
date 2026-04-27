// @ts-nocheck
import { describe, it, expect } from "vitest";
import { MemoryEnvironmentImageStrategy } from "@open-managed-agents/environment-images/memory";
import type { PrepareInput } from "@open-managed-agents/environment-images";

// ============================================================
// EnvironmentImageStrategy — port contract
// ============================================================
//
// Drives the in-memory adapter through the prepare → boot → reprepare
// lifecycle. The same scenarios any adapter (memory, cf-base-snapshot,
// cf-dockerfile, future-artifacts) must pass.

const baseInput = (env_id: string, packages?: Record<string, string[]>): PrepareInput => ({
  env_id,
  tenant_id: "tn_test",
  config: { type: "cloud", ...(packages ? { packages } : {}) } as PrepareInput["config"],
});

describe("MemoryEnvironmentImageStrategy — prepare", () => {
  it("records a snapshot per env and returns ready", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    const r = await s.prepare(baseInput("env-1", { pip: ["pandas", "pytest"] }));
    expect(r.status).toBe("ready");
    expect(r.sandbox_worker_name).toBe("sandbox-default");
    expect(r.handle).toBeDefined();
    expect(s.snapshots.has("env-1")).toBe(true);
  });

  it("hash is stable across same-content packages", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    await s.prepare(baseInput("a", { pip: ["b", "a"] }));
    await s.prepare(baseInput("a", { pip: ["a", "b"] }));
    const snap = s.snapshots.get("a")!;
    expect(snap.packages_hash).toContain("pip:a,b");
  });

  it("different envs get different snapshots", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    await s.prepare(baseInput("e1", { pip: ["pandas"] }));
    await s.prepare(baseInput("e2", { pip: ["numpy"] }));
    expect(s.snapshots.size).toBe(2);
    expect(s.snapshots.get("e1")!.packages_hash).not.toBe(s.snapshots.get("e2")!.packages_hash);
  });
});

describe("MemoryEnvironmentImageStrategy — bootSandbox", () => {
  it("returns a SandboxBoot with cache_hit=true after prepare", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    const prep = await s.prepare(baseInput("env-1", { pip: ["pandas"] }));
    const boot = await s.bootSandbox({
      env_id: "env-1",
      session_id: "sess-1",
      config: baseInput("env-1").config,
      handle: prep.handle,
    });
    expect(boot.cache_hit).toBe(true);
    expect(boot.duration_ms).toBeGreaterThanOrEqual(0);
    expect(boot.sandbox).toBeDefined();
  });

  it("the returned sandbox records exec calls", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    const prep = await s.prepare(baseInput("env-x"));
    const boot = await s.bootSandbox({
      env_id: "env-x",
      session_id: "sess-x",
      config: baseInput("env-x").config,
      handle: prep.handle,
    });
    const sandbox = boot.sandbox as { calls: string[]; exec(c: string): Promise<string> };
    await sandbox.exec("ls /home");
    await sandbox.exec("uname -a");
    expect(sandbox.calls).toEqual(["ls /home", "uname -a"]);
  });

  it("throws when no snapshot exists", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    await expect(s.bootSandbox({
      env_id: "missing",
      session_id: "sess-1",
      config: baseInput("missing").config,
    })).rejects.toThrow(/no snapshot/);
  });
});

describe("MemoryEnvironmentImageStrategy — reprepare", () => {
  it("reuses old snapshot when packages_hash matches", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    const prep = await s.prepare(baseInput("env-1", { pip: ["pandas"] }));
    const oldHandle = prep.handle;
    const reprep = await s.reprepare({
      ...baseInput("env-1", { pip: ["pandas"] }),
      previous_handle: oldHandle,
    });
    expect(reprep.handle).toBe(oldHandle);
  });

  it("rebuilds when packages change", async () => {
    const s = new MemoryEnvironmentImageStrategy();
    const prep = await s.prepare(baseInput("env-1", { pip: ["pandas"] }));
    const reprep = await s.reprepare({
      ...baseInput("env-1", { pip: ["pandas", "numpy"] }),
      previous_handle: prep.handle,
    });
    expect(reprep.handle).not.toBe(prep.handle);
    expect(reprep.status).toBe("ready");
  });
});
