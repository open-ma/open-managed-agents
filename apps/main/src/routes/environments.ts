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

/**
 * Trigger sandbox worker build via GitHub Actions.
 * Dispatches deploy-sandbox.yml with callback_url.
 * CI calls back to /build-complete when done, authenticated by shared secret.
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

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  const body = (await c.req.json()) as {
    name: string;
    description?: string;
    config: EnvironmentConfig["config"];
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);

  const initialRow = await c.var.services.environments.create({
    tenantId: t,
    name: body.name,
    description: body.description,
    config: body.config || { type: "cloud" },
    status: canBuild ? "building" : "ready",
    sandboxWorkerName: canBuild ? null : "sandbox-default",
  });

  let row = initialRow;
  if (canBuild) {
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

  const body = (await c.req.json()) as {
    status: "ready" | "error";
    sandbox_worker_name?: string;
    error?: string;
  };

  let workerName: string | null | undefined = undefined;
  if (body.status === "ready") {
    workerName = body.sandbox_worker_name || `sandbox-${id}`;

    if (c.env.CLOUDFLARE_API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
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
    status: body.status,
    buildError: body.error ?? null,
    ...(workerName !== undefined ? { sandboxWorkerName: workerName } : {}),
  });
  console.log(`[env] build-complete for ${id}: status=${body.status} worker=${row.sandbox_worker_name}`);
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

// PUT /v1/environments/:id — update environment (re-triggers build if config changed)
app.put("/:id", async (c) => {
  const t = c.get("tenant_id");
  const id = c.req.param("id");
  const existing = await c.var.services.environments.get({ tenantId: t, environmentId: id });
  if (!existing) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    name?: string;
    description?: string;
    config?: EnvironmentConfig["config"];
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

  if (configChanged) {
    const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);
    if (canBuild) {
      patch.status = "building";
      patch.sandboxWorkerName = null;
      patch.buildError = null;
    } else {
      patch.status = "ready";
      patch.sandboxWorkerName = existing.sandbox_worker_name ?? "sandbox-default";
    }
  }

  let row = await c.var.services.environments.update(patch);

  if (configChanged && row.status === "building") {
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
