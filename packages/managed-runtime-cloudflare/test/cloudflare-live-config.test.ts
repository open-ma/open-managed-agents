import { describe, expect, it } from "vitest";
import {
  buildCloudflareLiveConfig,
  cloudflareWorkerUrlFromDeployOutput,
  isCloudflareCommandKilled,
  isCloudflareDeployFailureTransient,
  isCloudflareWorkerRoutePending,
} from "./cloudflare-live-config";

describe("Cloudflare live certification config", () => {
  it("adds no persistence credentials to the ordinary container lifecycle lane", () => {
    const config = buildCloudflareLiveConfig({
      workerName: "oma-cf-cert-basic",
      workerPath: "/repo/worker.ts",
      dockerfilePath: "/repo/Dockerfile",
    });

    expect(config).not.toHaveProperty("r2_buckets");
    expect(config).not.toHaveProperty("vars");
  });

  it("binds a dedicated R2 bucket and production endpoint for checkpoint certification", () => {
    const config = buildCloudflareLiveConfig({
      workerName: "oma-cf-cert-r2",
      workerPath: "/repo/worker.ts",
      dockerfilePath: "/repo/Dockerfile",
      r2: {
        accountId: "account-id",
        bucketName: "oma-cert-bucket",
      },
    });

    expect(config.r2_buckets).toEqual([
      { binding: "BACKUP_BUCKET", bucket_name: "oma-cert-bucket" },
    ]);
    expect(config.vars).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      R2_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      BACKUP_BUCKET_NAME: "oma-cert-bucket",
    });
  });

  it("retries only the temporary workers.dev route propagation responses", () => {
    expect(isCloudflareWorkerRoutePending(404)).toBe(true);
    expect(isCloudflareWorkerRoutePending(530)).toBe(true);
    expect(isCloudflareWorkerRoutePending(401)).toBe(false);
    expect(isCloudflareWorkerRoutePending(500)).toBe(false);
  });

  it("accepts a deploy only when Wrangler reports the workers.dev URL", () => {
    expect(cloudflareWorkerUrlFromDeployOutput(
      "Uploaded oma-cert\nhttps://oma-cert.example.workers.dev",
    )).toBe("https://oma-cert.example.workers.dev");
    expect(cloudflareWorkerUrlFromDeployOutput(
      "Total Upload: 1701.90 KiB / gzip: 325.09 KiB",
    )).toBeUndefined();
  });

  it("retries provider stalls and missing deployment acknowledgement", () => {
    expect(isCloudflareDeployFailureTransient("connection reset by peer")).toBe(true);
    expect(isCloudflareDeployFailureTransient("deploy timed out after upload")).toBe(true);
    expect(isCloudflareDeployFailureTransient("deploy completed without a workers.dev URL")).toBe(true);
    expect(isCloudflareDeployFailureTransient("invalid wrangler configuration")).toBe(false);
    expect(isCloudflareCommandKilled({ killed: true })).toBe(true);
    expect(isCloudflareCommandKilled({ cause: { killed: true } })).toBe(true);
    expect(isCloudflareCommandKilled({ cause: { killed: false } })).toBe(false);
  });

});
