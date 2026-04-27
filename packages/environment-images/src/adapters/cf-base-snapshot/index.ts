// CfBaseSnapshotStrategy — packages installed once into
// /home/env-cache/<env_id>/, snapshotted via sandbox.createBackup,
// restored on every session boot. All envs share the
// `sandbox-default` worker — no per-env wrangler deploy.
//
// What this replaces (the old "per-env Dockerfile" path lives on as
// the cf-dockerfile adapter for users who need full image control):
//
//   Before: env create → GitHub Actions → generate.sh → Dockerfile
//           → wrangler deploy `sandbox-<env_id>` worker → ~90s
//   Now:    env create → one-shot sandbox → install packages into
//           cache dir → createBackup → store handle in D1 → ~20–60s
//   Boot:   restoreBackup → setEnvVars → ready in 1–2s (vs install
//           per session in the old shared-base path)
//
// What WON'T live in the snapshot (read this before assuming things
// "just work"):
//
//   - apt packages: install system-wide (/usr, /etc); the Backup API
//     only allows snapshot dirs under /workspace, /home, /tmp,
//     /var/tmp, /app. Adapter REJECTS env config with `apt` packages
//     and asks the user to either bake them into the base image or
//     accept install-on-boot via a separate code path.
//   - System config edits (sysctl, /etc/passwd, services): same
//     reason. Snapshot is FS-level only, not full container state.
//
// What IS in the snapshot:
//
//   - /home/env-cache/<env_id>/.venv          (uv venv, pip packages)
//   - /home/env-cache/<env_id>/node_modules   (npm --prefix)
//   - /home/env-cache/<env_id>/.cargo         (CARGO_HOME)
//   - /home/env-cache/<env_id>/.gem           (GEM_HOME)
//   - /home/env-cache/<env_id>/.go            (GOPATH)
//   - /home/env-cache/<env_id>/env.json       (env vars to setEnvVars)
//   - /home/env-cache/<env_id>/activate.sh    (for shell-in-sandbox users)

import type {
  BootInput,
  EnvironmentImageStrategy,
  PrepareInput,
  PrepareResult,
  SandboxBoot,
} from "../../ports";

/**
 * Persisted handle. Two parts:
 *   - `backup`: the @cloudflare/sandbox `DirectoryBackup` (small,
 *     `{id, dir}`); platform serializes to D1 column as JSON.
 *   - `env_vars`: the env vars to setEnvVars() at boot. Captured at
 *     prepare time so the runtime doesn't have to re-derive them
 *     from packages metadata.
 */
export interface CfBaseSnapshotHandle {
  backup: { id: string; dir: string };
  env_vars: Record<string, string>;
  cache_dir: string;
  packages_hash: string;
  prepared_at: number;
}

/** Minimal shape of the @cloudflare/sandbox object the adapter needs.
 *  Declared here to keep this file from importing the SDK directly —
 *  the consumer (session-do or main worker route) is responsible for
 *  passing in a `getSandbox` that returns something matching this. */
export interface CfSandboxLike {
  exec(command: string, options?: { timeout?: number; env?: Record<string, string> }): Promise<{
    exitCode: number; stdout: string; stderr: string;
  }>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
  readFile(path: string, options?: { encoding?: string }): Promise<string | { content: string }>;
  setEnvVars(envVars: Record<string, string>): Promise<unknown>;
  createBackup(opts: { dir: string; name?: string; ttl?: number; gitignore?: boolean }): Promise<{ id: string; dir: string }>;
  restoreBackup(handle: { id: string; dir: string }): Promise<{ success: boolean; dir: string; id: string }>;
  destroy?(): Promise<void>;
}

/** Caller supplies a factory because the binding depends on which
 *  worker the strategy is invoked from (main worker for prepare,
 *  SessionDO for boot). Both bindings point to the same shared
 *  `sandbox-default` worker — but the binding object is per-worker. */
export interface CfBaseSnapshotOptions {
  /** Returns a CfSandboxLike scoped to the given id. Adapter uses
   *  `prep-<env_id>-<ts>` for prepare() and `<session_id>` for
   *  bootSandbox(). */
  getSandbox(id: string): CfSandboxLike;
  /** Backup TTL in seconds. Default 90 days — long enough that even
   *  cold envs don't lose their snapshot between rare uses, short
   *  enough that abandoned envs eventually GC. CF default is 3 days
   *  which is way too aggressive for our use. */
  backup_ttl_seconds?: number;
}

const DEFAULT_TTL = 90 * 24 * 60 * 60; // 90 days

function hashPackages(packages: PackageSet | undefined): string {
  if (!packages) return "empty";
  const sorted = Object.keys(packages).sort()
    .map((k) => `${k}:${(packages[k as keyof PackageSet] ?? []).slice().sort().join(",")}`);
  return sorted.join("|") || "empty";
}

interface PackageSet {
  pip?: string[]; npm?: string[]; cargo?: string[]; gem?: string[]; go?: string[]; apt?: string[];
}

/** Produce the env vars that should be active in every session of
 *  this env so the cached binaries / libraries are on PATH. */
function buildEnvVars(cacheDir: string): Record<string, string> {
  return {
    // Python venv first on PATH so `python` / `pip` resolve there.
    PATH: `${cacheDir}/.venv/bin:${cacheDir}/node_modules/.bin:${cacheDir}/.cargo/bin:${cacheDir}/.gem/bin:${cacheDir}/.go/bin:/usr/local/bin:/usr/bin:/bin`,
    VIRTUAL_ENV: `${cacheDir}/.venv`,
    NODE_PATH: `${cacheDir}/node_modules`,
    CARGO_HOME: `${cacheDir}/.cargo`,
    GEM_HOME: `${cacheDir}/.gem`,
    GOPATH: `${cacheDir}/.go`,
    PYTHONPATH: `${cacheDir}/.venv/lib/python3.12/site-packages`,
  };
}

/** Generate the install commands sequentially. Each is its own exec
 *  so a partial failure surfaces with the right context. Order:
 *  cheap → expensive so failures abort early. */
function buildInstallCommands(packages: PackageSet, cacheDir: string): Array<{ name: string; cmd: string }> {
  const out: Array<{ name: string; cmd: string }> = [];
  const pip = packages.pip ?? [];
  const npm = packages.npm ?? [];
  const cargo = packages.cargo ?? [];
  const gem = packages.gem ?? [];
  const go = packages.go ?? [];

  // mkdir + writeable. Always runs even when no packages — gives us
  // an empty cache dir to snapshot, so bootSandbox always has something
  // to restore (avoids special-casing empty envs).
  out.push({ name: "mkdir", cmd: `mkdir -p ${cacheDir} && chmod -R u+rw ${cacheDir}` });

  if (pip.length > 0) {
    // uv venv + uv pip — uv is in the base image and ~10× faster than pip.
    out.push({ name: "venv", cmd: `uv venv ${cacheDir}/.venv --python 3.12` });
    out.push({ name: "pip", cmd: `uv pip install --python ${cacheDir}/.venv/bin/python ${pip.map((p) => JSON.stringify(p)).join(" ")}` });
  }
  if (npm.length > 0) {
    out.push({ name: "npm", cmd: `npm install --prefix ${cacheDir} --no-audit --no-fund ${npm.map((p) => JSON.stringify(p)).join(" ")}` });
  }
  if (cargo.length > 0) {
    out.push({ name: "cargo", cmd: `CARGO_HOME=${cacheDir}/.cargo cargo install ${cargo.map((p) => JSON.stringify(p)).join(" ")}` });
  }
  if (gem.length > 0) {
    out.push({ name: "gem", cmd: `GEM_HOME=${cacheDir}/.gem gem install --no-document ${gem.map((p) => JSON.stringify(p)).join(" ")}` });
  }
  if (go.length > 0) {
    out.push({ name: "go", cmd: `GOPATH=${cacheDir}/.go go install ${go.map((p) => JSON.stringify(p)).join(" ")}` });
  }

  return out;
}

/** activate.sh — for users who SSH/exec into the sandbox manually
 *  and want the same env. Not strictly needed for harness execs
 *  (we use setEnvVars), but a nice affordance. */
function buildActivateScript(envVars: Record<string, string>): string {
  return [
    "#!/bin/sh",
    "# Auto-generated by openma BaseSnapshotStrategy. Source to activate this env.",
    ...Object.entries(envVars).map(([k, v]) => `export ${k}="${v}"`),
    "",
  ].join("\n");
}

export class CfBaseSnapshotStrategy implements EnvironmentImageStrategy {
  readonly name = "base_snapshot";
  private readonly opts: Required<Pick<CfBaseSnapshotOptions, "backup_ttl_seconds">> & CfBaseSnapshotOptions;

  constructor(opts: CfBaseSnapshotOptions) {
    this.opts = { backup_ttl_seconds: DEFAULT_TTL, ...opts };
  }

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const cfg = input.config as { packages?: PackageSet };
    const packages: PackageSet = cfg.packages ?? {};

    // apt rejection — see header comment for why.
    if (packages.apt && packages.apt.length > 0) {
      return {
        status: "error",
        error: `BaseSnapshotStrategy does not support apt packages (${packages.apt.join(", ")}). apt installs system-wide and can't be snapshotted under /home. Either bake into the base image, drop the apt packages, or switch this env to image_strategy: "dockerfile".`,
      };
    }

    const cacheDir = `/home/env-cache/${input.env_id}`;
    const envVars = buildEnvVars(cacheDir);
    const cmds = buildInstallCommands(packages, cacheDir);
    const sandbox = this.opts.getSandbox(`prep-${input.env_id}-${Date.now()}`);

    try {
      // Run installs sequentially — order matters (venv before pip)
      // and a single failed step should kill the whole prepare with
      // the right context.
      for (const { name, cmd } of cmds) {
        const res = await sandbox.exec(cmd, { timeout: 600_000 }); // 10min per step
        if (res.exitCode !== 0) {
          return {
            status: "error",
            error: `prepare step "${name}" failed (exit=${res.exitCode}): ${res.stderr.slice(0, 500) || res.stdout.slice(0, 500)}`,
          };
        }
      }

      // Drop env vars + activate.sh into the cache dir — captured by
      // the snapshot so bootSandbox doesn't need to recompute them.
      await sandbox.writeFile(`${cacheDir}/env.json`, JSON.stringify(envVars, null, 2));
      await sandbox.writeFile(`${cacheDir}/activate.sh`, buildActivateScript(envVars));

      const backup = await sandbox.createBackup({
        dir: cacheDir,
        name: `env-${input.env_id}`,
        ttl: this.opts.backup_ttl_seconds,
      });

      const handle: CfBaseSnapshotHandle = {
        backup,
        env_vars: envVars,
        cache_dir: cacheDir,
        packages_hash: hashPackages(packages),
        prepared_at: Date.now(),
      };
      return {
        status: "ready",
        handle,
        sandbox_worker_name: "sandbox-default",
      };
    } catch (err) {
      return {
        status: "error",
        error: `prepare threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      // Best-effort cleanup of the one-shot prepare sandbox. Not awaited
      // hard so a destroy hang doesn't fail prepare.
      void sandbox.destroy?.();
    }
  }

  async bootSandbox(input: BootInput): Promise<SandboxBoot> {
    const start = Date.now();
    const handle = input.handle as CfBaseSnapshotHandle | undefined;
    if (!handle?.backup) {
      throw new Error(`base_snapshot.bootSandbox: missing handle for env ${input.env_id} (was prepare() called?)`);
    }
    const sandbox = this.opts.getSandbox(input.session_id);
    await sandbox.restoreBackup(handle.backup);
    await sandbox.setEnvVars(handle.env_vars);
    return {
      sandbox,
      cache_hit: true,
      duration_ms: Date.now() - start,
    };
  }

  async reprepare(input: PrepareInput & { previous_handle: unknown }): Promise<PrepareResult> {
    const prev = input.previous_handle as CfBaseSnapshotHandle | undefined;
    const cfg = input.config as { packages?: PackageSet };
    const newHash = hashPackages(cfg.packages);
    if (prev && prev.packages_hash === newHash) {
      // No-op — packages unchanged. The platform should have caught
      // this earlier (D1-side hash compare avoids spinning a sandbox);
      // adapter is defensive.
      return { status: "ready", handle: prev, sandbox_worker_name: "sandbox-default" };
    }
    return this.prepare(input);
  }
}
