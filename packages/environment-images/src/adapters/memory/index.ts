// In-memory adapter — for unit tests + a runnable reference for
// people implementing their own adapter. Persists no state outside
// the in-memory `snapshots` map; safe to instantiate per-test.
//
// Behavior mirrors what a real "base + snapshot" adapter would do:
//
//   prepare(env)  →  reads packages, simulates install (sleeps 0ms in
//                    tests, real adapter runs apt/pip/npm), records
//                    a fake handle keyed by env_id, returns "ready".
//   bootSandbox() →  looks up handle, returns a SandboxBoot with a
//                    fake sandbox object. cache_hit=true on subsequent
//                    boots of the same env_id.

import type {
  BootInput,
  EnvironmentImageStrategy,
  PrepareInput,
  PrepareResult,
  SandboxBoot,
} from "../../ports";

interface MemorySnapshot {
  env_id: string;
  packages: Record<string, string[] | undefined>;
  packages_hash: string;
  prepared_at: number;
}

export interface MemorySandbox {
  /** Fake exec — records every call so tests can assert on them. */
  calls: string[];
  exec(command: string): Promise<string>;
}

function hashPackages(packages: Record<string, string[] | undefined> | undefined): string {
  if (!packages) return "empty";
  const sorted = Object.keys(packages).sort().map((k) => `${k}:${(packages[k] ?? []).slice().sort().join(",")}`);
  return sorted.join("|") || "empty";
}

export class MemoryEnvironmentImageStrategy implements EnvironmentImageStrategy {
  readonly name = "memory";
  /** Public for tests to inspect. */
  readonly snapshots = new Map<string, MemorySnapshot>();

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const packages = (input.config as { packages?: Record<string, string[] | undefined> }).packages;
    const snap: MemorySnapshot = {
      env_id: input.env_id,
      packages: packages ?? {},
      packages_hash: hashPackages(packages),
      prepared_at: Date.now(),
    };
    this.snapshots.set(input.env_id, snap);
    return { status: "ready", handle: snap, sandbox_worker_name: "sandbox-default" };
  }

  async bootSandbox(input: BootInput): Promise<SandboxBoot> {
    const start = Date.now();
    const handle = (input.handle ?? this.snapshots.get(input.env_id)) as MemorySnapshot | undefined;
    if (!handle) throw new Error(`memory adapter: no snapshot for env ${input.env_id} — call prepare() first`);
    const cache_hit = this.snapshots.has(input.env_id);
    const sandbox: MemorySandbox = {
      calls: [],
      async exec(command: string) {
        sandbox.calls.push(command);
        return `exit=0\n(memory: ${command})`;
      },
    };
    return { sandbox, cache_hit, duration_ms: Date.now() - start };
  }

  async reprepare(input: PrepareInput & { previous_handle: unknown }): Promise<PrepareResult> {
    const prev = input.previous_handle as MemorySnapshot | undefined;
    const newPackages = (input.config as { packages?: Record<string, string[] | undefined> }).packages;
    const newHash = hashPackages(newPackages);
    if (prev && prev.packages_hash === newHash) {
      // Hash unchanged — reuse old snapshot (the platform-side hash check
      // would normally catch this earlier; adapters are defensive).
      return { status: "ready", handle: prev, sandbox_worker_name: "sandbox-default" };
    }
    return this.prepare(input);
  }
}
