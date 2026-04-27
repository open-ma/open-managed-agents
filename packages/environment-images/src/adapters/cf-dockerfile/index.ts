// CfDockerfileStrategy — opt-in adapter that wraps the existing
// per-env Dockerfile build pipeline (generate.sh + deploy-sandbox.yml +
// per-env wrangler deploy). Use when the user needs to bake apt
// packages, custom binaries, or full system config into the image
// — things the BaseSnapshotStrategy explicitly can't do.
//
// Constraint: the Dockerfile MUST `FROM` the openma sandbox base
// image. We DON'T let users pick an arbitrary base because:
//   1. The base contains @cloudflare/sandbox runtime hooks the harness
//      depends on (s3fs, fuse-overlayfs, jq, git, uv, ...).
//   2. Without the hooks, restoreBackup / mountBucket / outbound
//      handlers all silently fail.
//   3. Pinning the base also lets us version-bump the runtime without
//      asking every user to update their Dockerfile.
//
// User declares their additions in `config.dockerfile` as a free-form
// string of `RUN`/`COPY`/`ENV`/etc. lines. The adapter prepends
// `FROM ${BASE_IMAGE}` and rejects any user-provided FROM.
//
// What this adapter does in prepare():
//   1. Validate the dockerfile body (no FROM, no platform-controlled
//      directives we'd rather own).
//   2. Compose the final Dockerfile.
//   3. Dispatch the existing `deploy-sandbox.yml` GitHub Actions
//      workflow. The workflow builds + wrangler-deploys a per-env
//      worker named `sandbox-${env_id}` and callbacks back to main.
//   4. Return `status: "building"` — main worker stores the placeholder
//      handle and waits for the callback to fill in the rest.
//
// At bootSandbox() time, the per-env worker is the binding — there's
// no per-session restore. The handle just records `sandbox_worker_name`
// for the main router to pick up.

import type {
  BootInput,
  EnvironmentImageStrategy,
  PrepareInput,
  PrepareResult,
  SandboxBoot,
} from "../../ports";

/** Persisted handle. The worker name + the resolved Dockerfile body
 *  are enough to: (a) route sessions, (b) rebuild deterministically
 *  on a force-rebuild, (c) detect drift between config and deployment. */
export interface CfDockerfileHandle {
  sandbox_worker_name: string;
  /** SHA-256 of the composed Dockerfile body — for cheap drift detection. */
  dockerfile_hash: string;
  /** ms since epoch when the build started. */
  build_started_at: number;
}

/** Caller-supplied factory for triggering the GitHub Actions workflow.
 *  Real impl POSTs to api.github.com/...workflows/deploy-sandbox.yml/dispatches.
 *  Tests pass a stub. */
export type DispatchBuild = (req: {
  env_id: string;
  dockerfile_body: string;
  callback_url: string;
}) => Promise<void>;

/** Caller-supplied for boot — same shape as the base-snapshot
 *  adapter's `getSandbox`, but resolved against the per-env worker
 *  binding by the time we get here. */
export interface CfSandboxLikeMinimal {
  exec(command: string, options?: { timeout?: number; env?: Record<string, string> }): Promise<unknown>;
}

export interface CfDockerfileOptions {
  base_image?: string;
  /** Dispatcher for the GitHub Actions per-env build. Adapter invokes
   *  on prepare(); workflow callbacks the platform on completion. */
  dispatch_build: DispatchBuild;
  /** URL the workflow will POST status=ready/error back to. Per-env
   *  built into the URL by the caller (e.g. `${baseUrl}/v1/internal/env/${env_id}/build-complete`). */
  callback_url_for(env_id: string): string;
  /** Returns a sandbox-like for the given session_id, scoped to the
   *  per-env worker binding the platform resolved from the handle. */
  get_sandbox(session_id: string, sandbox_worker_name: string): CfSandboxLikeMinimal;
}

const DEFAULT_BASE_IMAGE = "docker.io/openma/sandbox-base:latest";

const FORBIDDEN_DIRECTIVES = ["FROM", "WORKDIR", "USER", "ENTRYPOINT", "CMD"] as const;

/** Validate the user dockerfile body and return the composed final
 *  Dockerfile. Throws on policy violations. */
export function composeDockerfile(userBody: string, baseImage: string = DEFAULT_BASE_IMAGE): string {
  const lines = userBody.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const upperFirst = trimmed.split(/\s+/)[0].toUpperCase();
    if ((FORBIDDEN_DIRECTIVES as readonly string[]).includes(upperFirst)) {
      throw new Error(
        `dockerfile mode rejects user-provided ${upperFirst} (line ${i + 1}). The platform owns base image, working dir, user, and entrypoint to keep harness hooks intact.`,
      );
    }
  }
  return [
    `# Auto-composed by openma DockerfileStrategy. DO NOT EDIT IN-PLACE — change config.dockerfile in the env API.`,
    `FROM ${baseImage}`,
    "",
    userBody.trim(),
    "",
  ].join("\n");
}

async function sha256Hex(input: string): Promise<string> {
  // Web Crypto — works in Workers, Node 20+ (globalThis.crypto.subtle), Bun, browsers.
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class CfDockerfileStrategy implements EnvironmentImageStrategy {
  readonly name = "dockerfile";
  private readonly opts: CfDockerfileOptions & { base_image: string };

  constructor(opts: CfDockerfileOptions) {
    this.opts = { base_image: DEFAULT_BASE_IMAGE, ...opts };
  }

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const cfg = input.config as { dockerfile?: string; packages?: Record<string, string[] | undefined> };
    const userBody = cfg.dockerfile ?? "";

    let composed: string;
    try {
      composed = composeDockerfile(userBody, this.opts.base_image);
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    // Surface a helpful warning when packages.* are also set — the
    // dockerfile path doesn't honor them (user can still RUN apt-get
    // install in their dockerfile body). We don't block, just hint.
    if (cfg.packages && Object.values(cfg.packages).some((arr) => Array.isArray(arr) && arr.length > 0)) {
      // Embed as a Dockerfile comment so it surfaces in build logs.
      composed = composed.replace(
        "FROM ",
        `# Note: config.packages is IGNORED in dockerfile mode. Add the equivalent\n# RUN steps to your config.dockerfile body.\nFROM `,
      );
    }

    const dockerfile_hash = await sha256Hex(composed);
    const sandbox_worker_name = `sandbox-${input.env_id}`;

    try {
      await this.opts.dispatch_build({
        env_id: input.env_id,
        dockerfile_body: composed,
        callback_url: this.opts.callback_url_for(input.env_id),
      });
    } catch (err) {
      return {
        status: "error",
        error: `dispatch_build failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const handle: CfDockerfileHandle = {
      sandbox_worker_name,
      dockerfile_hash,
      build_started_at: Date.now(),
    };

    // status=building — the workflow callback will flip this to
    // ready/error via the same patch path used by the legacy code.
    return {
      status: "building",
      handle,
      sandbox_worker_name,
    };
  }

  async bootSandbox(input: BootInput): Promise<SandboxBoot> {
    const start = Date.now();
    const handle = input.handle as CfDockerfileHandle | undefined;
    if (!handle?.sandbox_worker_name) {
      throw new Error(`dockerfile.bootSandbox: missing handle for env ${input.env_id} (was prepare() called and the build callback received?)`);
    }
    // Per-env worker has its own DO + container — image is already
    // baked. Just resolve the binding. cache_hit is meaningless for
    // this strategy (no snapshot restore step), but report `true` to
    // mean "no install on this boot".
    const sandbox = this.opts.get_sandbox(input.session_id, handle.sandbox_worker_name);
    return { sandbox, cache_hit: true, duration_ms: Date.now() - start };
  }

  async reprepare(input: PrepareInput & { previous_handle: unknown }): Promise<PrepareResult> {
    const prev = input.previous_handle as CfDockerfileHandle | undefined;
    const cfg = input.config as { dockerfile?: string };
    const composed = composeDockerfile(cfg.dockerfile ?? "", this.opts.base_image);
    const newHash = await sha256Hex(composed);
    if (prev && prev.dockerfile_hash === newHash) {
      return { status: "ready", handle: prev, sandbox_worker_name: prev.sandbox_worker_name };
    }
    return this.prepare(input);
  }
}
