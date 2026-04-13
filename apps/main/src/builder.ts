/**
 * Environment builder — uses DinD builder container to build and deploy
 * per-environment sandbox workers with custom container images.
 *
 * The BuilderSandbox container runs docker:dind-rootless with a Node.js
 * HTTP server (see builder/). Flow:
 *   1. POST /build to the builder container with Dockerfile + config
 *   2. Builder: docker build → docker push → wrangler deploy
 *   3. Returns result JSON
 */

import type { Env } from "@open-managed-agents/shared";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { getContainer } from "@cloudflare/containers";

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
 * Build and deploy a sandbox worker for the given environment.
 * Sends a build request to the DinD builder container.
 */
export async function buildAndDeploySandboxWorker(
  env: Env,
  envConfig: EnvironmentConfig,
): Promise<BuildResult> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { success: false, error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" };
  }

  const envId = envConfig.id;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const imageTag = `registry.cloudflare.com/${accountId}/sandbox-${envId}:latest`;

  try {
    console.log(`[builder] starting build for env ${envId}`);

    // Get a builder container stub and start it
    const stub = getContainer(env.BUILDER_SANDBOX as any, `builder-${envId}`);
    await stub.startAndWaitForPorts();
    console.log("[builder] container started, sending build request...");

    // Send build request to the container's HTTP server
    const dockerfile = generateDockerfile(envConfig.config.packages);
    const res = await stub.containerFetch("http://container/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dockerfile,
        image_tag: imageTag,
        cf_api_token: env.CLOUDFLARE_API_TOKEN,
        cf_account_id: accountId,
        repo_url: env.GITHUB_REPO || "https://github.com/open-ma/open-managed-agents",
        env_id: envId,
        kv_id: env.KV_NAMESPACE_ID || "5e49bdaec1884f5989037c86ece7b462",
      }),
    });

    const result = await res.json() as { success: boolean; sandbox_worker_name?: string; error?: string; steps?: string[] };
    console.log(`[builder] build result: success=${result.success}, steps=${result.steps?.join(",")}`);

    if (result.success) {
      return { success: true, sandbox_worker_name: result.sandbox_worker_name || `sandbox-${envId}` };
    } else {
      return { success: false, error: result.error };
    }
  } catch (err) {
    console.log(`[builder] error: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
