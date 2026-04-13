import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { generateEnvId } from "@open-managed-agents/shared";
import { buildAndDeploySandboxWorker } from "../builder";
import { addServiceBinding, envIdToBindingName } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env }>();

/**
 * Trigger sandbox worker build via DinD builder (async, updates KV when done).
 * Falls back to GitHub Actions if BUILDER_SANDBOX is not available.
 */
async function triggerBuild(env: Env, envConfig: EnvironmentConfig, ctx: ExecutionContext): Promise<void> {
  // Primary: DinD builder
  if (env.BUILDER_SANDBOX && env.CLOUDFLARE_API_TOKEN) {
    // Run via waitUntil so the build survives after the response is sent
    ctx.waitUntil((async () => {
      try {
        const result = await buildAndDeploySandboxWorker(env, envConfig);
        envConfig.status = result.success ? "ready" : "error";
        envConfig.sandbox_worker_name = result.sandbox_worker_name;
        if (!result.success) {
          envConfig.build_error = result.error;
        }
        envConfig.updated_at = new Date().toISOString();
        await env.CONFIG_KV.put(`env:${envConfig.id}`, JSON.stringify(envConfig));

        // PATCH main worker binding + store in KV
        if (result.success && result.sandbox_worker_name && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID) {
          const bindingName = envIdToBindingName(envConfig.id);
          await addServiceBinding(env.CLOUDFLARE_ACCOUNT_ID, "managed-agents", env.CLOUDFLARE_API_TOKEN, bindingName, result.sandbox_worker_name);
          await env.CONFIG_KV.put(`svcbind:${envConfig.id}`, result.sandbox_worker_name);
        }
      } catch (err) {
        // Always update status even on unexpected errors
        envConfig.status = "error";
        envConfig.build_error = err instanceof Error ? err.message : String(err);
        envConfig.updated_at = new Date().toISOString();
        await env.CONFIG_KV.put(`env:${envConfig.id}`, JSON.stringify(envConfig));
      }
    })());
    return;
  }

  // Fallback: GitHub Actions
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const [owner, repo] = env.GITHUB_REPO.split("/");
    await fetch(
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
  }
}

// POST /v1/environments — create environment
app.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    config: EnvironmentConfig["config"];
  }>();

  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }

  // If no build infrastructure (no DinD, no GitHub), default to ready
  const canBuild = !!(c.env.BUILDER_SANDBOX || (c.env.GITHUB_TOKEN && c.env.GITHUB_REPO));

  const env: EnvironmentConfig = {
    id: generateEnvId(),
    name: body.name,
    config: body.config || { type: "cloud" },
    status: canBuild ? "building" : "ready",
    sandbox_worker_name: canBuild ? undefined : "sandbox-default",
    created_at: new Date().toISOString(),
  };

  await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));

  console.log(`[env] canBuild=${canBuild}, BUILDER_SANDBOX=${!!c.env.BUILDER_SANDBOX}, CF_TOKEN=${!!c.env.CLOUDFLARE_API_TOKEN}, executionCtx=${!!c.executionCtx}`);
  if (canBuild) {
    try {
      await triggerBuild(c.env, env, c.executionCtx);
      console.log(`[env] triggerBuild returned for ${env.id}`);
    } catch (e) {
      console.log(`[env] triggerBuild threw: ${e instanceof Error ? e.message : String(e)}`);
      env.status = "error";
      await c.env.CONFIG_KV.put(`env:${env.id}`, JSON.stringify(env));
    }
  }

  return c.json(env, 201);
});

// POST /v1/environments/:id/build-complete — callback from DinD builder or GitHub Actions
app.post("/:id/build-complete", async (c) => {
  const id = c.req.param("id");

  const secret = c.req.header("x-build-secret");
  if (!secret || secret !== c.env.BUILD_CALLBACK_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const body = await c.req.json<{
    status: "ready" | "error";
    sandbox_worker_name?: string;
    error?: string;
  }>();

  const env: EnvironmentConfig = JSON.parse(data);
  env.status = body.status;

  if (body.status === "ready" && body.sandbox_worker_name) {
    env.sandbox_worker_name = body.sandbox_worker_name;

    // PATCH main worker to add service binding
    if (c.env.CLOUDFLARE_API_TOKEN && c.env.CLOUDFLARE_ACCOUNT_ID) {
      try {
        const bindingName = envIdToBindingName(id);
        await addServiceBinding(
          c.env.CLOUDFLARE_ACCOUNT_ID,
          "managed-agents",
          c.env.CLOUDFLARE_API_TOKEN,
          bindingName,
          body.sandbox_worker_name,
        );
      } catch (err) {
        // PATCH failed — still mark ready, deploy.sh will fix bindings
      }
    }

    // Store binding info in KV for deploy.sh to rebuild on redeploy
    await c.env.CONFIG_KV.put(`svcbind:${id}`, body.sandbox_worker_name);
  }

  env.updated_at = new Date().toISOString();
  await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
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

// PUT /v1/environments/:id — update environment
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  const data = await c.env.CONFIG_KV.get(`env:${id}`);
  if (!data) return c.json({ error: "Environment not found" }, 404);

  const env: EnvironmentConfig = JSON.parse(data);
  const body = await c.req.json<{
    name?: string;
    config?: EnvironmentConfig["config"];
  }>();

  if (body.name !== undefined) env.name = body.name;

  if (body.config !== undefined) {
    const oldConfig = JSON.stringify(env.config);
    env.config = body.config;
    const newConfig = JSON.stringify(body.config);

    if (newConfig !== oldConfig) {
      const canBuild = !!(c.env.BUILDER_SANDBOX || (c.env.GITHUB_TOKEN && c.env.GITHUB_REPO));
      if (canBuild) {
        env.status = "building";
        env.sandbox_worker_name = undefined;
        await c.env.CONFIG_KV.put(`env:${id}`, JSON.stringify(env));
        try {
          await triggerBuild(c.env, env, c.executionCtx);
        } catch {
          env.status = "error";
        }
      } else {
        // No build infra — packages will be installed during sandbox warmup
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
