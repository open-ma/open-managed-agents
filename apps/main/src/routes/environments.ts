import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { addServiceBinding, envIdToBindingName } from "@open-managed-agents/cf-billing";
import type { Services } from "@open-managed-agents/services";
import {
  toEnvironmentConfig,
  EnvironmentNotFoundError,
} from "@open-managed-agents/environments-store";
import { kvKey } from "../kv-helpers";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

/** Resolve which image strategy a request asks for. New envs default
 *  to `base_snapshot`. Existing envs (from before this field existed)
 *  read `null` and we treat as `dockerfile` for back-compat — they
 *  already have per-env workers deployed. */
type ImageStrategy = "base_snapshot" | "dockerfile";
function pickStrategy(requested?: string | null, existing?: string | null): ImageStrategy {
  if (requested === "base_snapshot" || requested === "dockerfile") return requested;
  if (existing === "base_snapshot" || existing === "dockerfile") return existing;
  return "base_snapshot";
}

/**
 * Trigger sandbox worker build via GitHub Actions (legacy / dockerfile mode).
 * Dispatches deploy-sandbox.yml with callback_url. CI calls back to
 * /build-complete when done.
 */
async function triggerBuild(env: Env, envConfig: EnvironmentConfig, requestUrl: string): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;

  const url = new URL(requestUrl);
  const callbackUrl = `${url.protocol}//${url.host}/v1/environments/${envConfig.id}/build-complete`;

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy-sandbox.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "open-managed-agents",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          env_id: envConfig.id,
          packages_json: JSON.stringify(envConfig.config.packages || {}),
          callback_url: callbackUrl,
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }
}

/** Run the base_snapshot prepare path: POST to the agent worker's
 *  /__internal/prepare-env over the SANDBOX_sandbox_default service
 *  binding. The agent worker has the SANDBOX DO namespace and runs
 *  the install + createBackup ASYNC, callbacking the env's
 *  /build-complete URL with the result. We just kick it off here. */
async function dispatchBaseSnapshotPrepare(
  env: Env,
  envConfig: EnvironmentConfig,
  tenantId: string,
  requestUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const binding = (env as unknown as Record<string, unknown>)["SANDBOX_sandbox_default"] as Fetcher | undefined;
  if (!binding) {
    return { ok: false, error: "SANDBOX_sandbox_default binding not configured" };
  }
  const internalToken = (env as unknown as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!internalToken) {
    return { ok: false, error: "INTERNAL_TOKEN secret not configured" };
  }
  const url = new URL(requestUrl);
  const callbackUrl = `${url.protocol}//${url.host}/v1/environments/${envConfig.id}/build-complete`;
  const res = await binding.fetch("https://internal/__internal/prepare-env", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": internalToken,
    },
    body: JSON.stringify({
      env_id: envConfig.id,
      tenant_id: tenantId,
      config: envConfig.config,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `dispatch returned ${res.status}: ${text.slice(0, 500)}` };
  }
  return { ok: true };
}

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    description?: string;
    config: EnvironmentConfig["config"];
    image_strategy?: "base_snapshot" | "dockerfile";
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const strategy = pickStrategy(body.image_strategy);

  // Create the row first so we have an env_id to pass to the strategy.
  // status starts at "building"; the strategy result flips it to ready/error.
  const initialRow = await c.var.services.environments.create({
    tenantId: t,
    name: body.name,
    description: body.description,
    config: body.config || { type: "cloud" },
    status: "building",
    sandboxWorkerName: null,
    imageStrategy: strategy,
  });

  let row = initialRow;
  if (strategy === "base_snapshot") {
    const dispatch = await dispatchBaseSnapshotPrepare(c.env, toEnvironmentConfig(row), t, c.req.url);
    if (!dispatch.ok) {
      row = await c.var.services.environments.update({
        tenantId: t,
        environmentId: row.id,
        status: "error",
        buildError: dispatch.error,
      });
    }
    // status stays "building" — agent worker callbacks /build-complete with the handle.
  } else {
    // dockerfile strategy: dispatch CI as before. status stays "building"
    // until /build-complete callback flips it.
    const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);
    if (!canBuild) {
      row = await c.var.services.environments.update({
        tenantId: t,
        environmentId: row.id,
        status: "ready",
        sandboxWorkerName: "sandbox-default",
      });
    } else {
      try {
        await triggerBuild(c.env, toEnvironmentConfig(row), c.req.url);
      } catch (e) {
        console.log(`[env] triggerBuild failed: ${e instanceof Error ? e.message : String(e)}`);
        row = await c.var.services.environments.update({
          tenantId: t,
          environmentId: row.id,
          status: "error",
          buildError: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return c.json(toEnvironmentConfig(row), 201);
});

// POST /v1/environments/:id/build-complete — callback from GitHub Actions
// Authenticated by the same x-api-key as all other endpoints (via authMiddleware)
app.post("/:id/build-complete", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");

  const existing = await c.var.services.environments.get({
    tenantId: t,
    environmentId: id,
  });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  // Two callback shapes accepted (one path, two callers):
  //   - Legacy dockerfile build (deploy-sandbox.yml): {status, sandbox_worker_name?, error?}
  //   - base_snapshot prepare    (agent worker):       PrepareResult-shaped — {status, handle?, sandbox_worker_name?, error?}
  // Both come in here. We unify by reading whichever fields landed.
  //
  // The base_snapshot path also carries x-internal-token for auth; the
  // legacy path is gated by the same x-api-key as everything else (via
  // authMiddleware). Either is sufficient for now; long-term we should
  // require the internal token for both.
  const body = (await c.req.json()) as {
    status: "ready" | "error" | "building";
    sandbox_worker_name?: string;
    error?: string;
    handle?: Record<string, unknown>;
  };

  let workerName: string | null | undefined = undefined;
  if (body.status === "ready") {
    workerName = body.sandbox_worker_name || `sandbox-${id}`;

    // Only call the dockerfile-mode service-binding plumbing for envs
    // that actually went through that path (per-env worker name). For
    // base_snapshot envs, sandbox-default is already bound — no add needed.
    const isPerEnvWorker = workerName !== "sandbox-default";
    if (isPerEnvWorker && c.env.CLOUDFLARE_API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
      try {
        const bindingName = envIdToBindingName(id);
        await addServiceBinding(
          c.env.CLOUDFLARE_ACCOUNT_ID, "managed-agents", c.env.CLOUDFLARE_API_TOKEN,
          bindingName, workerName,
        );
      } catch (err) {
        console.log(`[env] addServiceBinding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Legacy svcbind breadcrumb (write-only — no readers; kept for ops debugging).
    await c.env.CONFIG_KV.put(kvKey(t, "svcbind", id), workerName);
  }

  const row = await c.var.services.environments.update({
    tenantId: t,
    environmentId: id,
    status: body.status === "building" ? "building" : body.status,
    buildError: body.error ?? null,
    ...(workerName !== undefined ? { sandboxWorkerName: workerName } : {}),
    ...(body.handle !== undefined ? { imageHandle: body.handle } : {}),
  });
  console.log(`[env] build-complete for ${id}: status=${body.status} worker=${row.sandbox_worker_name} handle=${body.handle ? "set" : "unset"}`);
  return c.json(toEnvironmentConfig(row));
});

// GET /v1/environments — list environments
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const rows = await c.var.services.environments.list({ tenantId: t });
  return c.json({ data: rows.map(toEnvironmentConfig) });
});

// GET /v1/environments/:id — get environment
app.get("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const row = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!row) return c.json({ error: "Environment not found" }, 404);
  return c.json(toEnvironmentConfig(row));
});

// PUT /v1/environments/:id — update environment (re-prepares image if config changed)
app.put("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    description?: string;
    config?: EnvironmentConfig["config"];
    image_strategy?: "base_snapshot" | "dockerfile";
  };

  const patch: Parameters<typeof c.var.services.environments.update>[0] = {
    tenantId: t,
    environmentId: id,
  };
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;

  let configChanged = false;
  if (body.config !== undefined) {
    const oldConfig = JSON.stringify(existing.config);
    if (JSON.stringify(body.config) !== oldConfig) configChanged = true;
    patch.config = body.config;
  }

  // Strategy switch is a re-prepare too — different code path = new image.
  const strategyChanged = body.image_strategy !== undefined && body.image_strategy !== existing.image_strategy;
  const strategy = pickStrategy(body.image_strategy, existing.image_strategy);
  if (strategyChanged) patch.imageStrategy = strategy;

  if (configChanged || strategyChanged) {
    patch.status = "building";
    patch.buildError = null;
    patch.imageHandle = null;
    if (strategy === "dockerfile") patch.sandboxWorkerName = null;
  }

  let row = await c.var.services.environments.update(patch);

  if (configChanged || strategyChanged) {
    if (strategy === "base_snapshot") {
      const dispatch = await dispatchBaseSnapshotPrepare(c.env, toEnvironmentConfig(row), t, c.req.url);
      if (!dispatch.ok) {
        row = await c.var.services.environments.update({
          tenantId: t,
          environmentId: id,
          status: "error",
          buildError: dispatch.error,
        });
      }
      // else: status stays "building" — callback flips it.
    } else {
      try {
        await triggerBuild(c.env, toEnvironmentConfig(row), c.req.url);
      } catch (e) {
        row = await c.var.services.environments.update({
          tenantId: t,
          environmentId: id,
          status: "error",
          buildError: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return c.json(toEnvironmentConfig(row));
});

// POST /v1/environments/:id/archive
app.post("/:id/archive", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  try {
    const row = await c.var.services.environments.archive({
      tenantId: t,
      environmentId: id,
    });
    return c.json(toEnvironmentConfig(row));
  } catch (err) {
    if (err instanceof EnvironmentNotFoundError) {
      return c.json({ error: "Environment not found" }, 404);
    }
    throw err;
  }
});

// DELETE /v1/environments/:id
app.delete("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  // Refuse if any active session in the tenant references this environment.
  const hasActiveSessions = await c.var.services.sessions.hasActiveByEnvironment({
    tenantId: t,
    environmentId: id,
  });
  if (hasActiveSessions) {
    return c.json({ error: "Cannot delete environment referenced by active sessions" }, 409);
  }

  // Refuse if any pending/running eval run still targets this environment.
  const hasActiveEvals = await c.var.services.evals.hasActiveByEnvironment({
    tenantId: t,
    environmentId: id,
  });
  if (hasActiveEvals) {
    return c.json({
      error: "Cannot delete environment referenced by active eval runs",
    }, 409);
  }

  await c.var.services.environments.delete({ tenantId: t, environmentId: id });
  return c.json({ type: "environment_deleted", id });
});

export default app;
