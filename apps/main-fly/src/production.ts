type Environment = Record<string, string | undefined>;

const FLY_APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function assignDefault(environment: Environment, key: string, value: string): void {
  if (!environment[key]?.trim()) environment[key] = value;
}

function publicOrigin(environment: Environment): string {
  const explicit = environment.PUBLIC_BASE_URL?.trim();
  if (explicit) {
    const url = new URL(explicit);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new TypeError("PUBLIC_BASE_URL must be a bare HTTPS origin");
    }
    return url.origin;
  }

  const appName = environment.FLY_APP_NAME?.trim() ?? "";
  if (!FLY_APP_NAME.test(appName)) {
    throw new TypeError("FLY_APP_NAME must be a valid Fly app name when PUBLIC_BASE_URL is not set");
  }
  return `https://${appName}.fly.dev`;
}

/**
 * Normalize Fly Machines metadata into the existing Node platform contract.
 * The adapter intentionally owns only deployment concerns: the application,
 * stores, harnesses, and sandbox drivers remain the same portable Node ports.
 */
export function prepareFlyMachineEnvironment(environment: Environment): void {
  const origin = publicOrigin(environment);
  const sandboxProvider = environment.SANDBOX_PROVIDER?.trim().toLowerCase() ?? "";
  if (!sandboxProvider || sandboxProvider === "subprocess") {
    throw new TypeError(
      "Fly deployments require an isolated SANDBOX_PROVIDER; subprocess is test-only",
    );
  }

  environment.OPENMA_PROCESS_MODE = "standalone";
  environment.SANDBOX_PROVIDER = sandboxProvider;
  environment.PUBLIC_BASE_URL = origin;
  assignDefault(environment, "GATEWAY_ORIGIN", origin);
  assignDefault(environment, "NODE_ENV", "production");
  assignDefault(environment, "HOST", "0.0.0.0");
  assignDefault(environment, "PORT", "8080");
  assignDefault(environment, "DATABASE_PATH", "/app/data/oma.db");
  assignDefault(environment, "AUTH_DATABASE_PATH", "/app/data/auth.db");
  assignDefault(environment, "SANDBOX_WORKDIR", "/app/data/sandboxes");
  assignDefault(environment, "MEMORY_BLOB_DIR", "/app/data/memory-blobs");
  assignDefault(environment, "FILES_BLOB_DIR", "/app/data/files-blobs");
  assignDefault(environment, "SESSION_OUTPUTS_DIR", "/app/data/session-outputs");
}
