import Anthropic from "@anthropic-ai/sdk";
import type { DispatchedManagedEnvironmentWorkerClient } from "@open-managed-agents/managed-runtime-host";
import type { VercelSdkPort } from "@open-managed-agents/vercel-sandbox-contract";
import { waitUntil } from "@vercel/functions";
import { Sandbox } from "@vercel/sandbox";

import {
  readVercelControlPlaneConfig,
  readVercelFunctionBoundaryConfig,
} from "./config.js";
import { createVercelEnvironmentWorker } from "./environment-worker.js";
import { createVercelControlPlaneHandler } from "./handler.js";

type Environment = Record<string, string | undefined>;

function prepareServerlessNodeEnvironment(environment: Environment): void {
  environment.OPENMA_PROCESS_MODE = "serverless";
  environment.MEMORY_QUEUE = "disabled";
  environment.FEISHU_WS_RUNNER = "0";
  environment.SESSION_OUTPUTS_DIR ??= "/tmp/openma/session-outputs";
  const productionDomain = environment.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!environment.PUBLIC_BASE_URL?.trim() && productionDomain) {
    let publicUrl: URL;
    try {
      publicUrl = new URL(`https://${productionDomain}`);
    } catch (error) {
      throw new TypeError("VERCEL_PROJECT_PRODUCTION_URL must be a valid domain", { cause: error });
    }
    if (
      publicUrl.username
      || publicUrl.password
      || publicUrl.pathname !== "/"
      || publicUrl.search
      || publicUrl.hash
    ) {
      throw new TypeError("VERCEL_PROJECT_PRODUCTION_URL must be a bare domain");
    }
    environment.PUBLIC_BASE_URL = publicUrl.origin;
  }
}

function sandboxClient(): VercelSdkPort {
  return {
    getOrCreate: (input) => Sandbox.getOrCreate(input as never) as never,
    get: (input) => Sandbox.get(input as never) as never,
  };
}

/** Build the production Vercel function boundary once per warm isolate. */
export function createProductionVercelControlPlane(
  environment: Environment = process.env,
) {
  prepareServerlessNodeEnvironment(environment);
  const boundary = readVercelFunctionBoundaryConfig(environment);

  return createVercelControlPlaneHandler({
    async loadApi() {
      const module = await import("@open-managed-agents/main-node") as {
        app: { fetch(request: Request): Promise<Response> | Response };
      };
      return module.app;
    },
    async loadEnvironmentWorker() {
      const config = readVercelControlPlaneConfig(environment);
      const controlClient = new Anthropic({
        apiKey: config.environmentKey,
        baseURL: config.apiBaseUrl,
        webhookKey: config.webhookSecret,
        maxRetries: 0,
      }) as unknown as DispatchedManagedEnvironmentWorkerClient;
      return createVercelEnvironmentWorker(config, {
        controlClient,
        sandboxClient: sandboxClient(),
        onError(error) {
          console.error("[openma:vercel-environment-worker]", error);
        },
      });
    },
    waitUntil,
    cronSecret: boundary.cronSecret,
    pollTimeoutMs: boundary.pollTimeoutMs,
    onError(error) {
      console.error("[openma:vercel-control-plane]", error);
    },
  });
}
