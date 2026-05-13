// CF entry shim — builds the EvalRunnerContext from the worker `env`
// and forwards to @open-managed-agents/evals-runner.
//
// All business logic lives in the package; this file only exists because
// (a) the integration test test/integration/evals-route.test.ts imports
// `tickEvalRuns(env)` by path, and (b) CF binding lookups by name
// (`SANDBOX_*`, `SESSION_DO`) are CF-specific plumbing that doesn't
// belong in a shared package.

import type { Env } from "@open-managed-agents/shared";
import {
  forEachShardServices,
  getCfServicesForTenant,
  type Services,
} from "@open-managed-agents/services";
import {
  tickEvalRuns as tickRunsImpl,
  type EvalRunnerContext,
  type SandboxFetcher,
} from "@open-managed-agents/evals-runner";

const servicesCache = new Map<string, Services>();

async function getServices(env: Env, tenantId: string): Promise<Services> {
  let cached = servicesCache.get(tenantId);
  if (!cached) {
    cached = await getCfServicesForTenant(env, tenantId);
    servicesCache.set(tenantId, cached);
  }
  return cached;
}

async function getSandboxBinding(
  env: Env,
  tenantId: string,
  environmentId: string,
): Promise<SandboxFetcher | null> {
  const services = await getServices(env, tenantId);
  const envRow = await services.environments.get({ tenantId, environmentId });
  if (!envRow) return null;
  if (envRow.status !== "ready") return null;
  if (!envRow.sandbox_worker_name) return null;
  const bindingName = `SANDBOX_${envRow.sandbox_worker_name.replace(/-/g, "_")}`;
  const binding = (env as unknown as Record<string, unknown>)[bindingName] as Fetcher | undefined;
  if (binding) return binding;

  // Combined-worker test mode fallback.
  if (env.SESSION_DO) {
    const localFetcher: SandboxFetcher = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
        if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
        const [, sessionId, rest] = match;
        const doId = env.SESSION_DO!.idFromName(sessionId);
        const stub = env.SESSION_DO!.get(doId);
        return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        }));
      },
    };
    return localFetcher;
  }
  return null;
}

export function buildCfEvalRunnerContext(env: Env): EvalRunnerContext {
  return {
    forEachShard: (fn) => forEachShardServices(env, (s) => fn(s)),
    getServicesForTenant: (tenantId) => getServices(env, tenantId),
    getSandboxBinding: (tenantId, environmentId) =>
      getSandboxBinding(env, tenantId, environmentId),
  };
}

/** Same signature as the pre-extract eval-runner — kept for the
 *  integration test that imports this path. */
export async function tickEvalRuns(env: Env): Promise<{ advanced: number; total: number }> {
  return tickRunsImpl(buildCfEvalRunnerContext(env));
}
