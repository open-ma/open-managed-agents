/**
 * Environment builder — uses DinD Sandbox to build and deploy
 * per-environment sandbox workers with custom container images.
 *
 * Flow:
 *   1. Generate Dockerfile from packages config
 *   2. docker build inside DinD sandbox
 *   3. docker push to Cloudflare registry (temp credentials)
 *   4. wrangler deploy the sandbox worker
 */

import type { Env } from "./env";
import type { EnvironmentConfig } from "./types";

interface BuildResult {
  success: boolean;
  sandbox_worker_name?: string;
  error?: string;
}

/**
 * Generate a Dockerfile from packages config.
 */
function generateDockerfile(packages?: EnvironmentConfig["config"]["packages"]): string {
  // Use local Dockerfile as base on arm64 (Apple Silicon) since cloudflare/sandbox
  // registry images are amd64-only. On amd64/CI, use the registry image.
  const baseImage = "docker.io/cloudflare/sandbox:0.7.0";
  const lines = [`FROM ${baseImage}`];

  if (!packages) return lines.join("\n");

  if (packages.apt?.length) {
    lines.push(`RUN apt-get update && apt-get install -y ${packages.apt.join(" ")} && rm -rf /var/lib/apt/lists/*`);
  }
  if (packages.pip?.length) {
    lines.push(`RUN pip install --no-cache-dir ${packages.pip.join(" ")}`);
  }
  if (packages.npm?.length) {
    lines.push(`RUN npm install -g ${packages.npm.join(" ")}`);
  }
  if (packages.cargo?.length) {
    lines.push(`RUN cargo install ${packages.cargo.join(" ")}`);
  }
  if (packages.gem?.length) {
    lines.push(`RUN gem install ${packages.gem.join(" ")}`);
  }
  if (packages.go?.length) {
    lines.push(`RUN go install ${packages.go.join(" ")}`);
  }

  return lines.join("\n");
}

/**
 * Generate minimal wrangler.jsonc for a sandbox worker.
 */
function generateWranglerConfig(envId: string, kvId: string, imageRef: string): string {
  return JSON.stringify({
    name: `sandbox-${envId}`,
    main: "index.ts",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    containers: [{
      class_name: "Sandbox",
      image: imageRef,
      instance_type: "lite",
      max_instances: 10,
    }],
    durable_objects: {
      bindings: [
        { name: "SESSION_DO", class_name: "SessionDO" },
        { name: "SANDBOX", class_name: "Sandbox" },
      ],
    },
    kv_namespaces: [{ binding: "CONFIG_KV", id: kvId }],
    r2_buckets: [{ binding: "WORKSPACE_BUCKET", bucket_name: "managed-agents-workspace" }],
    migrations: [{ tag: "v1", new_sqlite_classes: ["SessionDO", "Sandbox"] }],
    limits: { cpu_ms: 300000 },
    observability: { enabled: true },
  }, null, 2);
}

/**
 * Build and deploy a sandbox worker for the given environment.
 * Runs inside a DinD Sandbox container.
 */
export async function buildAndDeploySandboxWorker(
  env: Env,
  envConfig: EnvironmentConfig,
): Promise<BuildResult> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { success: false, error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" };
  }

  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(env.BUILDER_SANDBOX, `builder-${envConfig.id}`);

  const envId = envConfig.id;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const imageTag = `registry.cloudflare.com/${accountId}/sandbox-${envId}:latest`;
  const workDir = `/tmp/build-${envId}`;

  try {
    // Wait for Docker daemon to be ready
    let ready = false;
    for (let i = 0; i < 15; i++) {
      const check = await sandbox.exec("docker version 2>/dev/null && echo READY || echo WAITING");
      if (check.stdout?.includes("READY")) { ready = true; break; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!ready) return { success: false, error: "Docker daemon failed to start" };

    // 1. Generate Dockerfile
    const dockerfile = generateDockerfile(envConfig.config.packages);
    await sandbox.writeFile(`${workDir}/Dockerfile`, dockerfile);

    // 2. Build image
    const build = await sandbox.exec(
      `docker build --network=host -t ${imageTag} ${workDir} 2>&1`,
      { timeout: 600000 } // 10 min
    );
    if (!build.success) {
      return { success: false, error: `Docker build failed: ${build.stderr || build.stdout}` };
    }

    // 3. Get temporary push credentials and push
    const credCmd = `CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}" npx wrangler containers registries credentials --push 2>/dev/null`;
    const credResult = await sandbox.exec(credCmd, { timeout: 30000 });
    if (credResult.stdout) {
      // Parse credentials JSON and docker login
      await sandbox.exec(
        `echo '${credResult.stdout.trim()}' | docker login --username _json_key --password-stdin registry.cloudflare.com 2>&1`,
        { timeout: 30000 }
      );
    }

    const push = await sandbox.exec(`docker push ${imageTag} 2>&1`, { timeout: 300000 });
    if (!push.success) {
      return { success: false, error: `Docker push failed: ${push.stderr || push.stdout}` };
    }

    // 4. Generate wrangler config and sandbox worker code, then deploy
    const kvId = "5e49bdaec1884f5989037c86ece7b462"; // TODO: make configurable
    const wranglerConfig = generateWranglerConfig(envId, kvId, imageTag);
    await sandbox.writeFile(`${workDir}/wrangler.jsonc`, wranglerConfig);

    // Write minimal sandbox worker entry point
    const workerCode = `
import { Sandbox } from "@cloudflare/sandbox";
export { Sandbox };

// SessionDO and harness imported from the shared package
// For now, deploy a minimal proxy that forwards to SessionDO
import { DurableObject } from "cloudflare:workers";

export class SessionDO extends DurableObject {
  async fetch(request) { return new Response("SessionDO stub", { status: 501 }); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\\/sessions\\/([^/]+)\\/(.*)/);
    if (!match) return new Response("Not found", { status: 404 });
    const [, sessionId, rest] = match;
    const doId = env.SESSION_DO.idFromName(sessionId);
    const stub = env.SESSION_DO.get(doId);
    return stub.fetch(new Request("http://internal/" + rest, {
      method: request.method,
      headers: request.headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    }));
  }
};
`;
    await sandbox.writeFile(`${workDir}/index.ts`, workerCode);

    // Deploy
    const deploy = await sandbox.exec(
      `cd ${workDir} && CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${accountId}" npx wrangler deploy --config wrangler.jsonc 2>&1`,
      { timeout: 120000 }
    );
    if (!deploy.success) {
      return { success: false, error: `Wrangler deploy failed: ${deploy.stderr || deploy.stdout}` };
    }

    return { success: true, sandbox_worker_name: `sandbox-${envId}` };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
