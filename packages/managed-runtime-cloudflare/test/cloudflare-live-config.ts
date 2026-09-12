interface CloudflareLiveConfigInput {
  workerName: string;
  workerPath: string;
  dockerfilePath: string;
  r2?: {
    accountId: string;
    bucketName: string;
  };
}

export function isCloudflareWorkerRoutePending(status: number): boolean {
  return status === 404 || status === 530;
}

export function cloudflareWorkerUrlFromDeployOutput(output: string): string | undefined {
  return output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
}

export function isCloudflareDeployFailureTransient(message: string): boolean {
  return /(?:429|50[234]|malformed response|connection termination|connection reset|no such manifest|timed out|without a workers\.dev URL)/i.test(message);
}

export function isCloudflareCommandKilled(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4 && typeof candidate === "object" && candidate !== null; depth += 1) {
    if ((candidate as { killed?: unknown }).killed === true) return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

export function buildCloudflareLiveConfig(input: CloudflareLiveConfigInput) {
  return {
    name: input.workerName,
    main: input.workerPath,
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    containers: [{
      class_name: "Sandbox",
      image: input.dockerfilePath,
      instance_type: "standard-1",
      max_instances: 1,
    }],
    durable_objects: { bindings: [{ name: "SANDBOX", class_name: "Sandbox" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox"] }],
    observability: { enabled: false },
    ...(input.r2 === undefined
      ? {}
      : {
          r2_buckets: [{ binding: "BACKUP_BUCKET", bucket_name: input.r2.bucketName }],
          vars: {
            CLOUDFLARE_ACCOUNT_ID: input.r2.accountId,
            R2_ENDPOINT: `https://${input.r2.accountId}.r2.cloudflarestorage.com`,
            BACKUP_BUCKET_NAME: input.r2.bucketName,
          },
        }),
  };
}
