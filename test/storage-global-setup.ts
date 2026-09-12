import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  MinioContainer,
  type StartedMinioContainer,
} from "@testcontainers/minio";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import type { StorageIntegrationConfig } from "./storage-integration.js";

const POSTGRES_IMAGE = "postgres:16-alpine";
// Pin the official Quay multi-arch manifest. 2025-09-07 is an `mc` client
// release, not a MinIO Server image, and Docker Hub now answers 404 for that
// mistaken tag on clean CI runners.
const MINIO_IMAGE =
  "quay.io/minio/minio@sha256:d249d1fb6966de4d8ad26c04754b545205ff15a62e4fd19ebd0f26fa5baacbc0";
const REGION = "us-east-1";
const POSTGRES_DATABASES = {
  agentsSql: "openma_agents_sql_test",
  sessionsSql: "openma_sessions_sql_test",
  feishuSchema: "openma_feishu_schema_test",
  betterAuth: "openma_better_auth_test",
  eventFanout: "openma_event_fanout_test",
  queue: "openma_queue_test",
  s3Memory: "openma_s3_memory_test",
  runtimeFence: "openma_runtime_fence_test",
} as const;

function databaseUrl(connectionUri: string, database: string): string {
  const url = new URL(connectionUri);
  url.pathname = `/${database}`;
  return url.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let postgres: StartedPostgreSqlContainer | undefined;
  let minio: StartedMinioContainer | undefined;
  let s3: S3Client | undefined;

  const stopContainers = async (): Promise<void> => {
    const failures: unknown[] = [];
    try {
      s3?.destroy();
    } catch (error) {
      failures.push(error);
    }
    const results = await Promise.allSettled([minio?.stop(), postgres?.stop()]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to stop storage test containers");
    }
  };

  try {
    postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase("openma_bootstrap_test")
      .withUsername("openma")
      .withPassword("openma-test-password")
      .start();

    for (const database of Object.values(POSTGRES_DATABASES)) {
      const created = await postgres.exec([
        "createdb",
        "--username",
        postgres.getUsername(),
        "--owner",
        postgres.getUsername(),
        database,
      ]);
      if (created.exitCode !== 0) {
        throw new Error(
          `Failed to create PostgreSQL test database ${database}: ${created.stderr}`,
        );
      }
    }

    minio = await new MinioContainer(MINIO_IMAGE)
      .withUsername("openma-test")
      .withPassword("openma-test-password")
      .start();

    const bucket = `openma-storage-test-${Date.now().toString(36)}`;
    const endpoint = minio.getConnectionUrl();
    s3 = new S3Client({
      endpoint,
      region: REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: minio.getUsername(),
        secretAccessKey: minio.getPassword(),
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const connectionUri = postgres.getConnectionUri();
    const config: StorageIntegrationConfig = {
      postgres: {
        agentsSql: databaseUrl(connectionUri, POSTGRES_DATABASES.agentsSql),
        sessionsSql: databaseUrl(connectionUri, POSTGRES_DATABASES.sessionsSql),
        feishuSchema: databaseUrl(connectionUri, POSTGRES_DATABASES.feishuSchema),
        betterAuth: databaseUrl(connectionUri, POSTGRES_DATABASES.betterAuth),
        eventFanout: databaseUrl(connectionUri, POSTGRES_DATABASES.eventFanout),
        queue: databaseUrl(connectionUri, POSTGRES_DATABASES.queue),
        s3Memory: databaseUrl(connectionUri, POSTGRES_DATABASES.s3Memory),
        runtimeFence: databaseUrl(connectionUri, POSTGRES_DATABASES.runtimeFence),
      },
      s3: {
        endpoint,
        bucket,
        accessKey: minio.getUsername(),
        secretKey: minio.getPassword(),
        region: REGION,
      },
    };
    project.provide("storageIntegration", config);
  } catch (error) {
    await stopContainers().catch(() => undefined);
    throw error;
  }

  return stopContainers;
}
