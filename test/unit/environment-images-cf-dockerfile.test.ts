// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  CfDockerfileStrategy,
  composeDockerfile,
} from "@open-managed-agents/environment-images/cf-dockerfile";
import type { CfDockerfileHandle } from "@open-managed-agents/environment-images/cf-dockerfile";

// ============================================================
// CfDockerfileStrategy — opt-in, must FROM base
// ============================================================

const baseInput = (env_id: string, dockerfile?: string, packages?: any) => ({
  env_id,
  tenant_id: "tn_test",
  config: { type: "cloud", ...(dockerfile !== undefined ? { dockerfile } : {}), ...(packages ? { packages } : {}) } as any,
});

describe("composeDockerfile — policy gate", () => {
  it("prepends FROM base and includes user body verbatim", () => {
    const out = composeDockerfile("RUN apt-get install -y ffmpeg\nENV FOO=bar");
    expect(out).toMatch(/^# Auto-composed/m);
    expect(out).toMatch(/^FROM docker\.io\/openma\/sandbox-base:latest$/m);
    expect(out).toMatch(/RUN apt-get install -y ffmpeg/);
    expect(out).toMatch(/ENV FOO=bar/);
  });

  it("rejects user-provided FROM", () => {
    expect(() => composeDockerfile("FROM ubuntu:22.04\nRUN echo hi")).toThrow(/FROM/);
  });

  it("rejects WORKDIR / USER / ENTRYPOINT / CMD (platform owns those)", () => {
    expect(() => composeDockerfile("WORKDIR /app")).toThrow(/WORKDIR/);
    expect(() => composeDockerfile("USER root")).toThrow(/USER/);
    expect(() => composeDockerfile("ENTRYPOINT [\"/bin/sh\"]")).toThrow(/ENTRYPOINT/);
    expect(() => composeDockerfile("CMD [\"sleep\", \"infinity\"]")).toThrow(/CMD/);
  });

  it("ignores comments and blank lines when scanning for forbidden directives", () => {
    expect(() => composeDockerfile("# FROM ubuntu  is just a comment\n\nRUN echo ok")).not.toThrow();
  });

  it("respects custom base_image option", () => {
    const out = composeDockerfile("RUN echo hi", "registry.example.com/openma/sandbox:v9");
    expect(out).toMatch(/FROM registry\.example\.com\/openma\/sandbox:v9/);
  });
});

describe("CfDockerfileStrategy.prepare — dispatch + handle", () => {
  it("dispatches the build with the composed dockerfile, returns building", async () => {
    const dispatched: any[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async (req) => { dispatched.push(req); },
      callback_url_for: (id) => `https://api.example/v1/internal/env/${id}/build-complete`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });

    const r = await strat.prepare(baseInput("env-x", "RUN apt-get install -y ffmpeg"));
    expect(r.status).toBe("building");
    expect(r.sandbox_worker_name).toBe("sandbox-env-x");

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].env_id).toBe("env-x");
    expect(dispatched[0].callback_url).toBe("https://api.example/v1/internal/env/env-x/build-complete");
    expect(dispatched[0].dockerfile_body).toMatch(/^FROM docker\.io\/openma\/sandbox-base:latest$/m);
    expect(dispatched[0].dockerfile_body).toMatch(/RUN apt-get install -y ffmpeg/);

    const handle = r.handle as CfDockerfileHandle;
    expect(handle.sandbox_worker_name).toBe("sandbox-env-x");
    expect(handle.dockerfile_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.build_started_at).toBeGreaterThan(0);
  });

  it("annotates dockerfile when packages.* is also set (warns, doesn't reject)", async () => {
    const dispatched: any[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async (req) => { dispatched.push(req); },
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    await strat.prepare(baseInput("e1", "RUN echo hi", { pip: ["pandas"] }));
    expect(dispatched[0].dockerfile_body).toMatch(/IGNORED in dockerfile mode/);
  });

  it("returns error on FROM in user body, never dispatches", async () => {
    const dispatched: any[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async (req) => { dispatched.push(req); },
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    const r = await strat.prepare(baseInput("bad", "FROM alpine"));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/FROM/);
    expect(dispatched).toEqual([]);
  });

  it("returns error when dispatch_build throws", async () => {
    const strat = new CfDockerfileStrategy({
      dispatch_build: async () => { throw new Error("github 403"); },
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    const r = await strat.prepare(baseInput("x", "RUN echo hi"));
    expect(r.status).toBe("error");
    expect(r.error).toContain("github 403");
  });
});

describe("CfDockerfileStrategy.bootSandbox — resolves per-env binding", () => {
  it("resolves the per-env worker via get_sandbox", async () => {
    const captured: { id: string; worker: string }[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async () => undefined,
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: (id, worker) => {
        captured.push({ id, worker });
        return { exec: async () => undefined };
      },
    });
    const handle: CfDockerfileHandle = {
      sandbox_worker_name: "sandbox-env-1",
      dockerfile_hash: "0".repeat(64),
      build_started_at: Date.now(),
    };
    const boot = await strat.bootSandbox({
      env_id: "env-1",
      session_id: "sess-1",
      config: baseInput("env-1").config,
      handle,
    });
    expect(captured).toEqual([{ id: "sess-1", worker: "sandbox-env-1" }]);
    expect(boot.cache_hit).toBe(true);
    expect(boot.sandbox).toBeDefined();
  });

  it("throws when handle missing", async () => {
    const strat = new CfDockerfileStrategy({
      dispatch_build: async () => undefined,
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    await expect(strat.bootSandbox({
      env_id: "env-1",
      session_id: "sess-1",
      config: baseInput("env-1").config,
    })).rejects.toThrow(/missing handle/);
  });
});

describe("CfDockerfileStrategy.reprepare — hash-based skip", () => {
  it("reuses old handle when dockerfile body unchanged", async () => {
    const dispatched: any[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async (req) => { dispatched.push(req); },
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    const first = await strat.prepare(baseInput("env-1", "RUN echo a"));
    const oldHandle = first.handle as CfDockerfileHandle;
    dispatched.length = 0;

    const reprep = await strat.reprepare({
      ...baseInput("env-1", "RUN echo a"),
      previous_handle: oldHandle,
    });
    expect(reprep.handle).toBe(oldHandle);
    expect(dispatched).toEqual([]);
  });

  it("redispatches when dockerfile body changes", async () => {
    const dispatched: any[] = [];
    const strat = new CfDockerfileStrategy({
      dispatch_build: async (req) => { dispatched.push(req); },
      callback_url_for: (id) => `https://x/${id}`,
      get_sandbox: () => ({ exec: async () => undefined }),
    });
    const first = await strat.prepare(baseInput("env-1", "RUN echo a"));
    dispatched.length = 0;

    const reprep = await strat.reprepare({
      ...baseInput("env-1", "RUN echo b"),
      previous_handle: first.handle,
    });
    expect(reprep.status).toBe("building");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].dockerfile_body).toMatch(/RUN echo b/);
  });
});
