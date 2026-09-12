export type NodeProcessMode = "standalone" | "serverless";

type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

const requiredServerlessValues = [
  "PUBLIC_BASE_URL",
  "PLATFORM_ROOT_SECRET",
  "MEMORY_S3_ENDPOINT",
  "MEMORY_S3_BUCKET",
  "MEMORY_S3_ACCESS_KEY",
  "MEMORY_S3_SECRET_KEY",
  "FILES_S3_ENDPOINT",
  "FILES_S3_BUCKET",
  "FILES_S3_ACCESS_KEY",
  "FILES_S3_SECRET_KEY",
] as const;

function present(environment: ProcessEnvironment, key: string): boolean {
  const value = environment[key];
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveNodeProcessMode(environment: ProcessEnvironment): NodeProcessMode {
  const raw = environment.OPENMA_PROCESS_MODE?.trim() || "standalone";
  if (raw !== "standalone" && raw !== "serverless") {
    throw new TypeError(
      `OPENMA_PROCESS_MODE must be "standalone" or "serverless"; received ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Serverless instances are disposable request handlers. They may not quietly
 * fall back to SQLite or local blob directories because either would make a
 * cold start look healthy while losing canonical state on the next instance.
 */
export function validateNodeProcessEnvironment(environment: ProcessEnvironment): void {
  if (resolveNodeProcessMode(environment) !== "serverless") return;

  const databaseUrl = environment.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new TypeError("DATABASE_URL must be PostgreSQL in serverless mode");
  }
  for (const key of requiredServerlessValues) {
    if (!present(environment, key)) {
      throw new TypeError(`${key} is required in serverless mode`);
    }
  }
  if (environment.AUTH_DISABLED !== "1" && !present(environment, "BETTER_AUTH_SECRET")) {
    throw new TypeError("BETTER_AUTH_SECRET is required in serverless mode");
  }
}
