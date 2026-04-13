/**
 * Environment builder — deploys per-environment sandbox workers
 * with custom container images via wrangler.
 *
 * Flow:
 *   1. Clone agent source in a builder sandbox
 *   2. Generate Dockerfile from packages config
 *   3. Point wrangler.jsonc containers[].image at the Dockerfile
 *   4. wrangler deploy — Cloudflare builds the image and deploys
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
 * Generate wrangler.jsonc for a sandbox worker.
 * image points to the Dockerfile path — Cloudflare builds it during deploy.
 */
function generateWranglerConfig(envId: string, kvId: string, dockerfilePath: string): string {
  return JSON.stringify({
    name: `sandbox-${envId}`,
    main: "index.ts",
    compatibility_date: "2025-04-01",
    compatibility_flags: ["nodejs_compat"],
    containers: [{
      class_name: "Sandbox",
      image: dockerfilePath,
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
 * Runs inside a builder sandbox — no Docker daemon needed.
 * wrangler deploy handles image building from the Dockerfile.
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
  const workDir = `/tmp/build-${envId}`;

  try {
    // 1. Clone the agent source
    const repoUrl = env.GITHUB_REPO || "https://github.com/open-ma/open-managed-agents";
    const agentDir = `${workDir}/agent`;
    const cloneResult = await sandbox.exec(
      `GIT_TEMPLATE_DIR= git clone --depth 1 ${repoUrl} ${agentDir} 2>&1`,
      { timeout: 60_000 }
    );
    if (!cloneResult.success) {
      return { success: false, error: `Git clone failed: ${cloneResult.stderr || cloneResult.stdout}` };
    }

    // 2. Generate Dockerfile in the agent app directory
    const dockerfile = generateDockerfile(envConfig.config.packages);
    const dockerfilePath = `${agentDir}/apps/agent/Dockerfile`;
    await sandbox.writeFile(dockerfilePath, dockerfile);

    // 3. Generate wrangler.jsonc pointing image at the Dockerfile
    const kvId = env.KV_NAMESPACE_ID || "5e49bdaec1884f5989037c86ece7b462";
    const wranglerConfig = generateWranglerConfig(envId, kvId, "./Dockerfile");
    await sandbox.writeFile(`${agentDir}/apps/agent/wrangler.jsonc`, wranglerConfig);

    // 4. Install dependencies and deploy — wrangler builds the image from Dockerfile
    const deploy = await sandbox.exec(
      `cd ${agentDir} && npm install --workspace=apps/agent --workspace=packages/shared 2>&1 && ` +
      `cd apps/agent && CLOUDFLARE_API_TOKEN="${env.CLOUDFLARE_API_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${accountId}" npx wrangler deploy --config wrangler.jsonc 2>&1`,
      { timeout: 600_000 } // 10 min — npm install + wrangler deploy (includes image build)
    );
    if (!deploy.success) {
      return { success: false, error: `Deploy failed: ${deploy.stderr || deploy.stdout}` };
    }

    return { success: true, sandbox_worker_name: `sandbox-${envId}` };

  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
