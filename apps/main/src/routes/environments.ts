import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { generateEnvId } from "@open-managed-agents/shared";
import { addServiceBinding, envIdToBindingName } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env }>();

/**
 * Trigger sandbox worker build via GitHub Actions.
 * Dispatches deploy-sandbox.yml → CI builds image + deploys worker.
 * Status is checked lazily via GitHub API on GET.
 */
async function triggerBuild(env: Env, envConfig: EnvironmentConfig): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return;

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy-sandbox.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          env_id: envConfig.id,
          packages_json: JSON.stringify(envConfig.config.packages || {}),
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }

  // Store dispatch time to find the run later
  envConfig.build_dispatched_at = new Date().toISOString();
}

/**
 * Check GitHub Actions workflow run status for a building environment.
 * Finds the run by matching workflow + dispatch time, updates env status.
 */
async function checkBuildStatus(env: Env, envConfig: EnvironmentConfig): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || envConfig.status !== "building") return;

  const [owner, repo] = env.GITHUB_REPO.split("/");
  const since = envConfig.build_dispatched_at || envConfig.created_at;

  // Find recent runs for the deploy-sandbox workflow
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy-sandbox.yml/runs?created=%3E%3D${since}&per_page=10`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!res.ok) return; // silently skip on API error

  const data = (await res.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      created_at: string;
    }>;
  };

  // Find the most recent run created after our dispatch
  const run = data.workflow_runs.find(r => r.created_at >= since);
  if (!run) return; // run not started yet

  if (run.status !== "completed") return; // still running

  if (run.conclusion === "success") {
    envConfig.status = "ready";
    envConfig.sandbox_worker_name = `sandbox-${envConfig.id}`;
    delete envConfig.build_error;

    // Add service binding
    if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
      try {
        const bindingName = envIdToBindingName(envConfig.id);
        await addServiceBinding(
          env.CLOUDFLARE_ACCOUNT_ID, "managed-agents", env.CLOUDFLARE_API_TOKEN,
          bindingName, envConfig.sandbox_worker_name,
        );
      } catch (err) {
        console.log(`[env] addServiceBinding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await env.CONFIG_KV.put(`svcbind:${envConfig.id}`, envConfig.sandbox_worker_name);
  } else {
    envConfig.status = "error";
    envConfig.build_error = `GitHub Actions run failed: ${run.conclusion}`;
  }

  envConfig.updated_at = new Date().toISOString();
  await env.CONFIG_KV.put(`env:${envConfig.id}`, JSON.stringify(envConfig));
}

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const body = (await c.req.json()) as {
    name: string;
    config: EnvironmentConfig["config"];
  };

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);

  const env: EnvironmentConfig = {
    id: generateEnvId(),
    name: body.name,
    config: body.config || { type: "cloud" },
    status: canBuild ? "building" : "ready",
    sandbox_worker_name: canBuild ? undefined : "sandbox-default",
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));

  if (canBuild) {
    try {
      await triggerBuild(c.env, env);
      await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));
    } catch (e) {
      console.log(`[env] triggerBuild failed: ${e instanceof Error ? e.message : String(e)}`);
      env.status = "error";
      env.build_error = e instanceof Error ? e.message : String(e);
      await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));
    }
  }

  return c.json(env, 201);
});

// GET /v1/environments — list environments
app.get("/", async (c) => {
  const list = await c.env.CONFIG_KV.list({ prefix: "env:" });
  const envs = await Promise.all(
    list.keys.map(async (k) => {
      const data = await c.env.CONFIG_KV.get(k.name);
      return data ? JSON.parse(data) : null;
    })
  );
  return c.json({ data: envs.filter(Boolean) });
});

// GET /v1/environments/:id — get environment (lazy-checks build status)
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);

  // Lazy check: if building, poll GitHub API for run status
  if (env.status === "building") {
    await checkBuildStatus(c.env, env);
  }

  return c.json(env);
});

// PUT /v1/environments/:id — update environment (re-triggers build if config changed)
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  const body = (await c.req.json()) as {
    name?: string;
    config?: EnvironmentConfig["config"];
  };

  if (body.name !== undefined) env.name = body.name;

  if (body.config !== undefined) {
    const oldConfig = JSON.stringify(env.config);
    env.config = body.config;
    const newConfig = JSON.stringify(body.config);

    if (newConfig !== oldConfig) {
      const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);
      if (canBuild) {
        env.status = "building";
        env.sandbox_worker_name = undefined;
        delete env.build_error;
        await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
        try {
          await triggerBuild(c.env, env);
          await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
        } catch {
          env.status = "error";
        }
      } else {
        env.sandbox_worker_name = env.sandbox_worker_name || "sandbox-default";
        env.status = "ready";
      }
    }
  }

  env.updated_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  return c.json(env);
});

// POST /v1/environments/:id/archive — archive environment
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  env.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  return c.json(env);
});

// DELETE /v1/environments/:id — delete environment
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const sessionList = await c.env.CONFIG_KV.list({ prefix: "session:" });
  for (const k of sessionList.keys) {
    const sessionData = await c.env.CONFIG_KV.get(k.name);
    if (sessionData) {
      const session = JSON.parse(sessionData) as { environment_id: string; archived_at?: string };
      if (session.environment_id === id && !session.archived_at) {
        return c.json({ error: "Cannot delete environment referenced by active sessions" }, 409);
      }
    }
  }

  await c.env.CONFIG_KV.delete(`env:${id}`);
  return c.json({ type: "environment_deleted", id });
});

export default app;
