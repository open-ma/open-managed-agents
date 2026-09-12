import type {
  ManagedEnvironmentWorkDispatchPort,
} from "@open-managed-agents/managed-runtime-host";
import {
  renewVercelSandboxLease,
  type VercelNetworkPolicy,
  type VercelSdkPort,
} from "@open-managed-agents/vercel-sandbox-contract";
import { createHash } from "node:crypto";

const reservedEnvironment = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_SESSION_ID",
  "ANTHROPIC_WORK_ID",
  "ANTHROPIC_WORK_SECRET",
  "OPENMA_WORKSPACE_ID",
] as const;

export interface VercelDispatchedWorkerDeclaration {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

export interface VercelManagedEnvironmentDispatchOptions {
  client: VercelSdkPort;
  snapshotId: string;
  worker: VercelDispatchedWorkerDeclaration;
  timeoutMs?: number;
  region?: string;
  resources?: { vcpus: number };
  networkPolicy?(input: {
    apiBaseUrl: string;
    environmentId: string;
    sessionId: string;
    workId: string;
  }): VercelNetworkPolicy | Promise<VercelNetworkPolicy>;
  now?: () => number;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sandboxName(workId: string): string {
  return `oma-work-${hash(workId, 32)}`;
}

function ownershipTags(input: {
  environmentId: string;
  sessionId: string;
  workId: string;
}): Record<string, string> {
  return {
    openma: "managed-work",
    oma_environment: hash(input.environmentId, 24),
    oma_session: hash(input.sessionId, 24),
    oma_work: hash(input.workId, 24),
  };
}

function defaultNetworkPolicy(input: {
  apiBaseUrl: string;
  environmentId: string;
  workId: string;
}): VercelNetworkPolicy {
  const url = new URL(input.apiBaseUrl);
  return {
    allow: {
      // Work lifecycle, Session events, MCP, skills, and resource downloads
      // all use the same OpenMA origin and the Work-scoped sessions token.
      // Never inject the standing environment key into sandbox egress.
      [url.host]: [{}],
    },
  };
}

function workerEnvironment(
  declaration: VercelDispatchedWorkerDeclaration,
  input: {
    apiBaseUrl: string;
    environmentId: string;
    sessionId: string;
    workId: string;
    workSecret: string;
    workspaceId: string;
  },
): Record<string, string> {
  const custom = { ...(declaration.env ?? {}) };
  for (const name of reservedEnvironment) delete custom[name];
  return {
    ...custom,
    ANTHROPIC_BASE_URL: input.apiBaseUrl,
    ANTHROPIC_ENVIRONMENT_ID: input.environmentId,
    ANTHROPIC_SESSION_ID: input.sessionId,
    ANTHROPIC_WORK_ID: input.workId,
    ANTHROPIC_WORK_SECRET: input.workSecret,
    OPENMA_WORKSPACE_ID: input.workspaceId,
  };
}

/**
 * Vercel's reference lifecycle projected onto OpenMA's provider-dispatch Port.
 * The Function reserves Work but does not ACK it. This starts a session/work
 * keyed persistent Sandbox; the worker inside owns ACK, heartbeat, Session IO,
 * stop and recovery. `flock` makes repeated webhook/poll delivery process-safe.
 */
export function createManagedEnvironmentWorkDispatchPort(
  factoryOptions: VercelManagedEnvironmentDispatchOptions,
): ManagedEnvironmentWorkDispatchPort {
  const options = factoryOptions;
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Vercel dispatch options are required");
  }
  if (typeof options.client?.getOrCreate !== "function") {
    throw new TypeError("Vercel dispatch requires a Sandbox SDK client Port");
  }
  const snapshotId = nonEmpty(options.snapshotId, "snapshotId");
  const command = nonEmpty(options.worker?.command, "worker.command");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 60 * 60_000, "timeoutMs");
  const now = options.now ?? Date.now;

  return {
    descriptor() {
      return {
        provider: "vercel",
        version: "1.0.0",
        strategy: "poll_unacked_then_dispatch",
      };
    },

    async dispatch(input) {
      if (input.work.data.type !== "session") {
        throw new Error("Vercel dispatcher only accepts Session Work");
      }
      input.signal.throwIfAborted();
      const environmentId = input.work.environment_id;
      const sessionId = input.work.data.id;
      const workId = input.work.id;
      const workSecret = nonEmpty(input.work.secret, "work.secret");
      const name = sandboxName(workId);
      const tags = ownershipTags({ environmentId, sessionId, workId });
      const policyInput = {
        apiBaseUrl: input.apiBaseUrl,
        environmentId,
        sessionId,
        workId,
      };
      const networkPolicy = await (options.networkPolicy?.(policyInput)
        ?? defaultNetworkPolicy(policyInput));
      input.signal.throwIfAborted();
      const sandbox = await options.client.getOrCreate({
        name,
        persistent: true,
        resume: true,
        tags,
        networkPolicy,
        source: { type: "snapshot", snapshotId },
        timeout: timeoutMs,
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.resources === undefined ? {} : { resources: options.resources }),
        signal: input.signal,
      });
      if (
        sandbox.name !== name
        || !sandbox.persistent
        || Object.entries(tags).some(([key, value]) => sandbox.tags?.[key] !== value)
      ) {
        throw new Error("Refusing to attach a Vercel Sandbox with mismatched Work ownership");
      }
      await sandbox.updateNetworkPolicy(networkPolicy, { signal: input.signal });
      if (sandbox.expiresAt !== undefined) {
        await renewVercelSandboxLease({
          sandbox,
          ttlMs: timeoutMs,
          now,
          signal: input.signal,
        });
      }
      input.signal.throwIfAborted();
      await sandbox.runCommand({
        cmd: "/usr/bin/flock",
        args: [
          "-n",
          `/tmp/openma-work-${hash(workId, 24)}.lock`,
          command,
          ...(options.worker.args ?? []),
        ],
        cwd: options.worker.cwd ?? "/workspace",
        detached: true,
        env: workerEnvironment(options.worker, {
          apiBaseUrl: input.apiBaseUrl,
          environmentId,
          sessionId,
          workId,
          workSecret,
          workspaceId: input.workspaceId,
        }),
      });
      input.signal.throwIfAborted();
    },
  };
}
