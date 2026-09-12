import { describe, expect, it } from "vitest";
import {
  backupObjectKeys,
  resolveCloudflareR2Fixture,
} from "./cloudflare-live-r2-fixture";

describe("Cloudflare live R2 fixture", () => {
  it("reuses a configured bucket without claiming ownership of it", () => {
    expect(resolveCloudflareR2Fixture({
      configuredBucketName: "managed-agents-backups",
      generatedBucketName: "oma-cert-generated",
    })).toEqual({
      bucketName: "managed-agents-backups",
      ownsBucket: false,
    });
  });

  it("owns a generated bucket when no existing bucket is configured", () => {
    expect(resolveCloudflareR2Fixture({
      generatedBucketName: "oma-cert-generated",
    })).toEqual({
      bucketName: "oma-cert-generated",
      ownsBucket: true,
    });
  });

  it("limits shared-bucket cleanup to the exact backup handle", () => {
    expect(backupObjectKeys("2c76d8b0-9521-4ca5-8fc2-e2fc0a4d546a")).toEqual([
      "backups/2c76d8b0-9521-4ca5-8fc2-e2fc0a4d546a/data.sqsh",
      "backups/2c76d8b0-9521-4ca5-8fc2-e2fc0a4d546a/meta.json",
    ]);
  });
});
