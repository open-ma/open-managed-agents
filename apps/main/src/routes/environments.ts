import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { generateEnvId } from "@open-managed-agents/shared";
import { addServiceBinding, envIdToBindingName } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env }>();

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
      await triggerBuild(c.env, env, c.req.url);
    } catch (e) {
      console.log(`[env] triggerBuild failed: ${e instanceof Error ? e.message : String(e)}`);
      env.status = "error";
      env.build_error = e instanceof Error ? e.message : String(e);
      await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));
    }
  }

  return c.json(env, 201);
});

// POST /v1/environments/:id/build-complete — callback from GitHub Actions
// Authenticated by the same x-api-key as all other endpoints (via authMiddleware)
app.post("/:id/build-complete", async (c) => {
  const id = c.req.param("id");

  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const body = (await c.req.json()) as {
    status: "ready" | "error";
    sandbox_worker_name?: string;
    error?: string;
  };

  const env: EnvironmentConfig = JSON.parse(data);
  env.status = body.status;
  if (body.error) env.build_error = body.error;

  if (body.status === "ready") {
    env.sandbox_worker_name = body.sandbox_worker_name || `sandbox-${id}`;

    if (c.env.CLOUDFLARE_API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
      try {
        const bindingName = envIdToBindingName(id);
        await addServiceBinding(
          c.env.CLOUDFLARE_ACCOUNT_ID, "managed-agents", c.env.CLOUDFLARE_API_TOKEN,
          bindingName, env.sandbox_worker_name,
        );
      } catch (err) {
        console.log(`[env] addServiceBinding failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await c.env.CONFIG_KV.put(`svcbind:${id}`, env.sandbox_worker_name);
  }

  env.updated_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  console.log(`[env] build-complete for ${id}: status=${body.status} worker=${env.sandbox_worker_name}`);
  return c.json(env);
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

// GET /v1/environments/:id — get environment
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);
  return c.json(JSON.parse(data));
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

    if (JSON.stringify(body.config) !== oldConfig) {
      const canBuild = !!(c.env.GITHUB_TOKEN && c.env.GITHUB_REPO);
      if (canBuild) {
        env.status = "building";
        env.sandbox_worker_name = undefined;
        delete env.build_error;
        await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
        try {
          await triggerBuild(c.env, env, c.req.url);
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

// POST /v1/environments/:id/archive
app.post("/:id/archive", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  env.archived_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
  return c.json(env);
});

// DELETE /v1/environments/:id
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
