import type { VercelDispatchedWorkerDeclaration } from "@open-managed-agents/environment-dispatch-vercel";

type Environment = Readonly<Record<string, string | undefined>>;

export interface VercelControlPlaneConfig {
  apiBaseUrl: string;
  workspaceId: string;
  environmentId: string;
  environmentKey: string;
  webhookSecret: string;
  cronSecret: string;
  snapshotId: string;
  sandbox: {
    worker: VercelDispatchedWorkerDeclaration;
    timeoutMs: number;
    maxWorkItemsPerDrain: number;
    pollTimeoutMs: number;
    region?: string;
    resources?: { vcpus: number };
  };
}

export interface VercelFunctionBoundaryConfig {
  cronSecret?: string;
  pollTimeoutMs: number;
}

function required(environment: Environment, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new TypeError(`${key} is required`);
  return value;
}

function positiveInteger(environment: Environment, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value;
}

function workerArgs(environment: Environment): string[] {
  const raw = environment.OPENMA_VERCEL_WORKER_ARGS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new TypeError("not a string array");
    }
    return parsed;
  } catch (error) {
    throw new TypeError(
      "OPENMA_VERCEL_WORKER_ARGS_JSON must be a JSON array of strings",
      { cause: error },
    );
  }
}

function apiBaseUrl(environment: Environment): string {
  const raw = environment.OPENMA_SANDBOX_API_BASE_URL?.trim()
    || required(environment, "PUBLIC_BASE_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new TypeError("Control-plane API base URL must be HTTP(S)", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Control-plane API base URL must be HTTP(S)");
  }
  const local = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !local) {
    throw new TypeError("Control-plane API base URL must use HTTPS outside localhost");
  }
  return url.toString().replace(/\/+$/u, "");
}

/** Configuration needed before the heavy API/worker compositions are loaded. */
export function readVercelFunctionBoundaryConfig(
  environment: Environment,
): VercelFunctionBoundaryConfig {
  const cronSecret = environment.CRON_SECRET?.trim();
  return {
    ...(cronSecret ? { cronSecret } : {}),
    pollTimeoutMs: positiveInteger(
      environment,
      "OPENMA_VERCEL_POLL_TIMEOUT_MS",
      20_000,
    ),
  };
}

export function readVercelControlPlaneConfig(
  environment: Environment,
): VercelControlPlaneConfig {
  const boundary = readVercelFunctionBoundaryConfig(environment);
  const agentId = environment.OPENMA_VERCEL_ACP_AGENT_ID?.trim();
  const region = environment.OPENMA_VERCEL_REGION?.trim();
  const vcpus = environment.OPENMA_VERCEL_VCPUS?.trim()
    ? positiveInteger(environment, "OPENMA_VERCEL_VCPUS", 1)
    : undefined;
  const workerEnvironment: Record<string, string> = {
    OPENMA_HARNESS_ID: required(environment, "OPENMA_VERCEL_HARNESS_ID"),
    OPENMA_HARNESS_VERSION: environment.OPENMA_VERCEL_HARNESS_VERSION?.trim() || "1",
    ...(agentId ? { OPENMA_ACP_AGENT_ID: agentId } : {}),
  };

  return {
    apiBaseUrl: apiBaseUrl(environment),
    workspaceId: required(environment, "OPENMA_WORKSPACE_ID"),
    environmentId: required(environment, "OPENMA_ENVIRONMENT_ID"),
    environmentKey: required(environment, "OPENMA_ENVIRONMENT_KEY"),
    webhookSecret: required(environment, "OPENMA_ENVIRONMENT_WEBHOOK_SECRET"),
    cronSecret: boundary.cronSecret ?? required(environment, "CRON_SECRET"),
    snapshotId: required(environment, "OPENMA_VERCEL_SNAPSHOT_ID"),
    sandbox: {
      timeoutMs: positiveInteger(environment, "OPENMA_VERCEL_TIMEOUT_MS", 3_600_000),
      maxWorkItemsPerDrain: positiveInteger(
        environment,
        "OPENMA_VERCEL_MAX_WORK_ITEMS",
        4,
      ),
      pollTimeoutMs: boundary.pollTimeoutMs,
      worker: {
        command: required(environment, "OPENMA_VERCEL_WORKER_COMMAND"),
        args: workerArgs(environment),
        cwd: environment.OPENMA_VERCEL_WORKER_CWD?.trim() || "/workspace",
        env: workerEnvironment,
      },
      ...(region ? { region } : {}),
      ...(vcpus === undefined ? {} : { resources: { vcpus } }),
    },
  };
}
