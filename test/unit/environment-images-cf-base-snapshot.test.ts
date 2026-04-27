// @ts-nocheck
import { describe, it, expect, vi } from "vitest";
import { CfBaseSnapshotStrategy } from "@open-managed-agents/environment-images/cf-base-snapshot";
import type { CfBaseSnapshotHandle, CfSandboxLike } from "@open-managed-agents/environment-images/cf-base-snapshot";

// ============================================================
// CfBaseSnapshotStrategy — adapter contract
// ============================================================
//
// We test the adapter against a fake CfSandboxLike — captures every
// exec/writeFile/createBackup/restoreBackup/setEnvVars call so we can
// assert the install-then-snapshot sequence is right without spinning
// a real CF Container.

interface FakeSandbox extends CfSandboxLike {
  calls: Array<{ kind: string; args: unknown[] }>;
}

function makeFakeSandbox(execImpl?: (cmd: string) => { exitCode: number; stdout: string; stderr: string }): FakeSandbox {
  const calls: FakeSandbox["calls"] = [];
  return {
    calls,
    async exec(command: string, options?: any) {
      calls.push({ kind: "exec", args: [command, options] });
      return execImpl ? execImpl(command) : { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile(path: string, content: string, options?: any) {
      calls.push({ kind: "writeFile", args: [path, content, options] });
    },
    async readFile(path: string) {
      calls.push({ kind: "readFile", args: [path] });
      return "";
    },
    async setEnvVars(envVars: Record<string, string>) {
      calls.push({ kind: "setEnvVars", args: [envVars] });
    },
    async createBackup(opts: any) {
      calls.push({ kind: "createBackup", args: [opts] });
      return { id: `backup-${Math.random().toString(36).slice(2, 10)}`, dir: opts.dir };
    },
    async restoreBackup(handle: any) {
      calls.push({ kind: "restoreBackup", args: [handle] });
      return { success: true, dir: handle.dir, id: handle.id };
    },
    async destroy() {
      calls.push({ kind: "destroy", args: [] });
    },
  };
}

const baseInput = (env_id: string, packages?: any) => ({
  env_id,
  tenant_id: "tn_test",
  config: { type: "cloud", ...(packages ? { packages } : {}) } as any,
});

describe("CfBaseSnapshotStrategy.prepare — install + snapshot", () => {
  it("installs pip packages with uv and snapshots the cache dir", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("env-1", { pip: ["pandas", "pytest"] }));

    expect(r.status).toBe("ready");
    expect(r.sandbox_worker_name).toBe("sandbox-default");

    const execs = fake.calls.filter((c) => c.kind === "exec").map((c) => c.args[0] as string);
    expect(execs[0]).toMatch(/mkdir -p \/home\/env-cache\/env-1/);
    expect(execs.find((c) => c.startsWith("uv venv"))).toMatch(/\/home\/env-cache\/env-1\/\.venv/);
    expect(execs.find((c) => c.startsWith("uv pip install"))).toMatch(/"pandas".*"pytest"|"pytest".*"pandas"/);

    const backupCall = fake.calls.find((c) => c.kind === "createBackup");
    expect(backupCall).toBeDefined();
    expect((backupCall!.args[0] as any).dir).toBe("/home/env-cache/env-1");
    expect((backupCall!.args[0] as any).name).toBe("env-env-1");
    expect((backupCall!.args[0] as any).ttl).toBeGreaterThan(60 * 60 * 24); // > 1 day

    const handle = r.handle as CfBaseSnapshotHandle;
    expect(handle.backup.dir).toBe("/home/env-cache/env-1");
    expect(handle.env_vars.PATH).toContain("/home/env-cache/env-1/.venv/bin");
    expect(handle.env_vars.VIRTUAL_ENV).toBe("/home/env-cache/env-1/.venv");
  });

  it("handles npm + cargo + gem + go in one prepare", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    await strat.prepare(baseInput("multi", {
      npm: ["typescript"],
      cargo: ["ripgrep"],
      gem: ["jekyll"],
      go: ["github.com/x/y"],
    }));

    const execs = fake.calls.filter((c) => c.kind === "exec").map((c) => c.args[0] as string);
    expect(execs.find((c) => c.startsWith("npm install"))).toMatch(/--prefix \/home\/env-cache\/multi/);
    expect(execs.find((c) => c.startsWith("CARGO_HOME=/home/env-cache/multi/.cargo"))).toMatch(/cargo install.*"ripgrep"/);
    expect(execs.find((c) => c.startsWith("GEM_HOME=/home/env-cache/multi/.gem"))).toMatch(/gem install.*"jekyll"/);
    expect(execs.find((c) => c.startsWith("GOPATH=/home/env-cache/multi/.go"))).toMatch(/go install.*"github\.com\/x\/y"/);
  });

  it("snapshots an empty cache dir when no packages declared", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("plain"));
    expect(r.status).toBe("ready");
    const execs = fake.calls.filter((c) => c.kind === "exec").map((c) => c.args[0] as string);
    expect(execs).toHaveLength(1); // just mkdir
    expect(fake.calls.find((c) => c.kind === "createBackup")).toBeDefined();
  });

  it("REJECTS apt packages with an actionable error", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("apty", { apt: ["ffmpeg"] }));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/apt/);
    expect(r.error).toMatch(/dockerfile/i);
    // Did NOT spin up the install — fail-fast before the sandbox.
    expect(fake.calls).toEqual([]);
  });

  it("returns error and stops at first failed install step", async () => {
    let nth = 0;
    const fake = makeFakeSandbox((cmd) => {
      nth += 1;
      if (cmd.startsWith("uv pip install")) {
        return { exitCode: 1, stdout: "", stderr: "ResolutionImpossible: pandas==999" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("bad", { pip: ["pandas==999"] }));
    expect(r.status).toBe("error");
    expect(r.error).toContain("pip");
    expect(r.error).toContain("ResolutionImpossible");
    // No backup attempted on failure.
    expect(fake.calls.find((c) => c.kind === "createBackup")).toBeUndefined();
  });

  it("destroys the prepare sandbox even on success", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    await strat.prepare(baseInput("env-1"));
    expect(fake.calls.find((c) => c.kind === "destroy")).toBeDefined();
  });
});

describe("CfBaseSnapshotStrategy.bootSandbox — restore + setEnvVars", () => {
  it("restores the backup and sets env vars in one call", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const handle: CfBaseSnapshotHandle = {
      backup: { id: "bk_xyz", dir: "/home/env-cache/env-1" },
      env_vars: { PATH: "/home/env-cache/env-1/.venv/bin:/usr/bin", VIRTUAL_ENV: "/home/env-cache/env-1/.venv" },
      cache_dir: "/home/env-cache/env-1",
      packages_hash: "pip:pandas",
      prepared_at: Date.now(),
    };
    const boot = await strat.bootSandbox({
      env_id: "env-1",
      session_id: "sess-1",
      config: baseInput("env-1").config,
      handle,
    });
    expect(boot.cache_hit).toBe(true);
    expect(boot.duration_ms).toBeGreaterThanOrEqual(0);

    const restoreCall = fake.calls.find((c) => c.kind === "restoreBackup");
    expect(restoreCall).toBeDefined();
    expect((restoreCall!.args[0] as any).id).toBe("bk_xyz");

    const setEnvCall = fake.calls.find((c) => c.kind === "setEnvVars");
    expect((setEnvCall!.args[0] as any).PATH).toContain("/home/env-cache/env-1/.venv/bin");
  });

  it("throws when handle is missing", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    await expect(strat.bootSandbox({
      env_id: "env-1",
      session_id: "sess-1",
      config: baseInput("env-1").config,
    })).rejects.toThrow(/missing handle/);
  });
});

describe("CfBaseSnapshotStrategy.reprepare — incremental re-prep", () => {
  it("reuses old handle when packages_hash matches", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("env-1", { pip: ["pandas"] }));
    const old = r.handle as CfBaseSnapshotHandle;
    const fake2 = makeFakeSandbox();
    const strat2 = new CfBaseSnapshotStrategy({ getSandbox: () => fake2 });
    const reprep = await strat2.reprepare({
      ...baseInput("env-1", { pip: ["pandas"] }),
      previous_handle: old,
    });
    expect(reprep.handle).toBe(old);
    // Did NOT call back into install.
    expect(fake2.calls).toEqual([]);
  });

  it("rebuilds when packages change", async () => {
    const fake = makeFakeSandbox();
    const strat = new CfBaseSnapshotStrategy({ getSandbox: () => fake });
    const r = await strat.prepare(baseInput("env-1", { pip: ["pandas"] }));
    const old = r.handle as CfBaseSnapshotHandle;
    const fake2 = makeFakeSandbox();
    const strat2 = new CfBaseSnapshotStrategy({ getSandbox: () => fake2 });
    const reprep = await strat2.reprepare({
      ...baseInput("env-1", { pip: ["pandas", "numpy"] }),
      previous_handle: old,
    });
    expect(reprep.handle).not.toBe(old);
    expect(fake2.calls.find((c) => c.kind === "createBackup")).toBeDefined();
  });
});
