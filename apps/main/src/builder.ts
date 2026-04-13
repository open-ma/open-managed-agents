/**
 * Environment builder — uses DinD builder sandbox to build and deploy
 * per-environment sandbox workers with custom container images.
 *
 * The BuilderSandbox container runs docker:dind-rootless with dockerd
 * pre-started (see builder/Dockerfile). Flow:
 *   1. Generate Dockerfile from packages config
 *   2. docker build inside DinD builder
 *   3. docker push to Cloudflare registry (temp credentials via wrangler)
 *   4. wrangler deploy the sandbox worker with new image
 */

import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";

interface BuildResult {
  success: boolean;
  sandbox_worker_name?: string;
  error?: string;
}

/**
 * Generate a Dockerfile from packages config.
 */
function generateDockerfile(packages?: EnvironmentConfig["config"]["packages"]): string {
  const baseImage = "docker.io/cloudflare/sandbox:0.7.20";
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
 * Runs inside a DinD builder sandbox (docker:dind-rootless).
 */
export async function buildAndDeploySandboxWorker(
  env: Env,
  envConfig: EnvironmentConfig,
): Promise<BuildResult> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { success: false, error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" };
  }

  const { getSandbox } = await import("@cloudflare/sandbox");
  const sandbox = getSandbox(env.BUILDER_SANDBOX as any, `builder-${envConfig.id}`);

  const envId = envConfig.id;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const imageTag = `registry.cloudflare.com/${accountId}/sandbox-${envId}:latest`;
  const workDir = `/tmp/build-${envId}`;

  try {
    // Wait for Docker daemon to be ready (boot.sh starts dockerd on container start)
    let ready = false;
    for (let i = 0; i < 10; i++) {
      try {
        const check = await sandbox.exec(
          "docker version >/dev/null 2>&1 && echo READY || echo WAITING",
          { timeout: 5_000 }
        );
        if (check.stdout?.includes("READY")) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 2_000));
    }
    if (!ready) {
      return { success: false, error: "Docker daemon not ready after 20s. Is BuilderSandbox using the DinD image?" };
    }

    // 1. Generate Dockerfile
    const dockerfile = generateDockerfile(envConfig.config.packages);
    await sandbox.exec(`mkdir -p ${workDir}`, { timeout: 5_000 });
    await sandbox.writeFile(`${workDir}/Dockerfile`, dockerfile);

    // 2. Build image (--network=host required for DinD in Cloudflare Containers)
    const build = await sandbox.exec(
      `docker build --network=host -t ${imageTag} ${workDir} 2>&1`,
      { timeout: 600_000 }
    );
    if (!build.success) {
      return { success: false, error: `Docker build failed: ${build.stderr || build.stdout}` };
    }

    // 3. Get temp push credentials via wrangler and push
    const login = await sandbox.exec(
      `CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}" ` +
      `npx wrangler containers registries credentials --push 2>/dev/null | ` +
      `docker login --username _json_key --password-stdin registry.cloudflare.com 2>&1`,
      { timeout: 30_000 }
    );
    if (!login.success) {
      return { success: false, error: `Registry login failed: ${login.stderr || login.stdout}` };
    }

    const push = await sandbox.exec(
      `docker push ${imageTag} 2>&1`,
      { timeout: 300_000 }
    );
    if (!push.success) {
      return { success: false, error: `Docker push failed: ${push.stderr || push.stdout}` };
    }

    // 4. Clone agent source, set custom image, deploy
    const kvId = env.KV_NAMESPACE_ID || "5e49bdaec1884f5989037c86ece7b462";
    const wranglerConfig = generateWranglerConfig(envId, kvId, imageTag);

    const repoUrl = env.GITHUB_REPO || "https://github.com/open-ma/open-managed-agents";
    const agentDir = `${workDir}/agent`;
    const cloneResult = await sandbox.exec(
      `GIT_TEMPLATE_DIR= git clone --depth 1 ${repoUrl} ${agentDir} 2>&1`,
      { timeout: 60_000 }
    );
    if (!cloneResult.success) {
      return { success: false, error: `Git clone failed: ${cloneResult.stderr || cloneResult.stdout}` };
    }

    await sandbox.writeFile(`${agentDir}/apps/agent/wrangler.jsonc`, wranglerConfig);

    const deploy = await sandbox.exec(
      `cd ${agentDir} && npm install --workspace=apps/agent --workspace=packages/shared 2>&1 && ` +
      `cd apps/agent && CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}" ` +
      `CLOUDFLARE_ACCOUNT_ID="${accountId}" npx wrangler deploy --config wrangler.jsonc 2>&1`,
      { timeout: 600_000 }
    );
    if (!deploy.success) {
      return { success: false, error: `Deploy failed: ${deploy.stderr || deploy.stdout}` };
    }

    return { success: true, sandbox_worker_name: `sandbox-${envId}` };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
