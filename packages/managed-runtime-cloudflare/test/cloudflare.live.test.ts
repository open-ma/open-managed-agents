import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  buildCloudflareLiveConfig,
  cloudflareWorkerUrlFromDeployOutput,
  isCloudflareCommandKilled,
  isCloudflareDeployFailureTransient,
  isCloudflareWorkerRoutePending,
} from "./cloudflare-live-config";
import {
  backupObjectKeys,
  resolveCloudflareR2Fixture,
} from "./cloudflare-live-r2-fixture";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new NodeURL("../../..", import.meta.url)));
const live = process.env.OMA_CLOUDFLARE_LIVE_CERTIFICATION === "1";
const r2Live = live && process.env.OMA_CLOUDFLARE_R2_CERTIFICATION === "1";
const suite = live ? describe : describe.skip;
const workerName = `oma-cf-cert-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const sandboxId = `oma-cert-${randomUUID().replaceAll("-", "")}`;
const nonce = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
const proxySecret = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
let fixtureRoot = "";
let configPath = "";
let secretsPath = "";
const r2Fixture = resolveCloudflareR2Fixture({
  configuredBucketName: process.env.OMA_CLOUDFLARE_R2_BUCKET,
  generatedBucketName: `${workerName}-r2`.slice(0, 62),
});
const r2BucketName = r2Fixture.bucketName;
let r2BucketCreated = false;
const r2BackupIds = new Set<string>();

type ContainerApplication = { id: string; name: string; state: string };

async function wrangler(args: string[], timeout = 15 * 60_000) {
  try {
    return await execFileAsync("pnpm", ["exec", "wrangler", ...args], {
      cwd: repoRoot,
      env: { ...process.env, CI: "1" },
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const details = [String((error as { stdout?: string }).stdout ?? ""), String((error as { stderr?: string }).stderr ?? "")]
      .join("\n")
      .replaceAll(nonce, "<redacted>")
      .replaceAll(proxySecret, "<redacted>")
      .replace(/(env\.[A-Z0-9_]*(?:SECRET|NONCE)[A-Z0-9_]*\s+\(")[^"]*("\))/gi, "$1<redacted>$2");
    throw new Error(`wrangler command failed: ${details.slice(-4_096)}`, { cause: error });
  }
}

async function deployWithRetry(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const deployed = await wrangler([
        "deploy",
        "--config", configPath,
        "--name", workerName,
        "--secrets-file", secretsPath,
        "--containers-rollout", "immediate",
      ], 6 * 60_000);
      const deploymentOutput = `${deployed.stdout}\n${deployed.stderr}`;
      const workerUrl = cloudflareWorkerUrlFromDeployOutput(deploymentOutput);
      if (!workerUrl) {
        throw new Error(
          `Cloudflare deploy completed without a workers.dev URL: ${deploymentOutput.slice(-2_048)}`,
        );
      }
      return workerUrl;
    } catch (error) {
      lastError = error;
      const message = String(error);
      const transient = isCloudflareDeployFailureTransient(message)
        || isCloudflareCommandKilled(error);
      if (!transient || attempt === 3) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 5_000));
    }
  }
  throw lastError;
}

async function listOwnedContainerApplications(): Promise<ContainerApplication[]> {
  const { stdout } = await wrangler(["containers", "list", "--json"], 60_000);
  const applications = JSON.parse(stdout) as ContainerApplication[];
  return applications.filter(({ name }) => name.startsWith(workerName));
}

async function terminalContainerErrors(): Promise<string[]> {
  const errors: string[] = [];
  for (const application of await listOwnedContainerApplications()) {
    const { stdout } = await wrangler(["containers", "info", application.id], 60_000);
    const info = JSON.parse(stdout) as {
      health?: { errors?: Array<{ event?: { name?: string; message?: string } }> };
    };
    for (const error of info.health?.errors ?? []) {
      errors.push(`${error.event?.name ?? "ContainerError"}: ${error.event?.message ?? "unknown error"}`);
    }
  }
  return errors;
}

async function deleteResources(): Promise<void> {
  await wrangler(["delete", workerName, "--config", configPath, "--force"], 120_000).catch(() => undefined);
  for (const application of await listOwnedContainerApplications()) {
    await wrangler(["containers", "delete", application.id], 120_000);
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await listOwnedContainerApplications()).length === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
  }
  throw new Error(`Cloudflare certification resources leaked for ${workerName}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Cloudflare R2 certification`);
  return value;
}

async function createR2Bucket(): Promise<void> {
  if (!r2Live || !r2Fixture.ownsBucket) return;
  await wrangler(["r2", "bucket", "create", r2BucketName], 120_000);
  r2BucketCreated = true;
}

async function deleteR2Bucket(): Promise<void> {
  if (!r2Live) return;
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnvironment("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
    },
  });
  try {
    if (r2Fixture.ownsBucket) {
      let continuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: r2BucketName,
          ContinuationToken: continuationToken,
        }));
        const objects = (page.Contents ?? []).flatMap(({ Key }) =>
          Key === undefined ? [] : [{ Key }],
        );
        if (objects.length > 0) {
          await client.send(new DeleteObjectsCommand({
            Bucket: r2BucketName,
            Delete: { Objects: objects, Quiet: true },
          }));
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);
    } else {
      const objects = [...r2BackupIds].flatMap(backupObjectKeys).map((Key) => ({ Key }));
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({
          Bucket: r2BucketName,
          Delete: { Objects: objects, Quiet: true },
        }));
      }
    }
  } finally {
    client.destroy();
  }
  if (r2BucketCreated) {
    await wrangler(["r2", "bucket", "delete", r2BucketName], 120_000);
    r2BucketCreated = false;
  }
}

async function createIsolatedConfig(): Promise<void> {
  fixtureRoot = await mkdtemp(join(tmpdir(), `${workerName}-`));
  configPath = join(fixtureRoot, "wrangler.json");
  secretsPath = join(fixtureRoot, "secrets.json");
  const accountId = r2Live ? requiredEnvironment("CLOUDFLARE_ACCOUNT_ID") : undefined;
  await writeFile(configPath, JSON.stringify(buildCloudflareLiveConfig({
    workerName,
    workerPath: resolve(repoRoot, "apps/agent/test/cloudflare-live-certification-worker.ts"),
    dockerfilePath: resolve(repoRoot, "apps/agent/Dockerfile.sandbox"),
    ...(r2Live
      ? { r2: { accountId: accountId!, bucketName: r2BucketName } }
      : {}),
  }), null, 2));
  await writeFile(secretsPath, JSON.stringify({
    CERTIFICATION_NONCE: nonce,
    CERTIFICATION_PROXY_SECRET: proxySecret,
    ...(r2Live
      ? {
          R2_ACCESS_KEY_ID: requiredEnvironment("R2_ACCESS_KEY_ID"),
          R2_SECRET_ACCESS_KEY: requiredEnvironment("R2_SECRET_ACCESS_KEY"),
        }
      : {}),
  }), { mode: 0o600 });
}

async function invoke(
  url: string,
  action: "create" | "read" | "renew_lease" | "checkpoint" | "restore" | "attach_proxy" | "proxy" | "revoke_proxy" | "destroy" | "verify_destroyed",
  extra: Record<string, unknown> = {},
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${nonce}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, sandbox_id: sandboxId, ...extra }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`certification endpoint returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForCreate(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10 * 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await invoke(url, "create");
    } catch (error) {
      lastError = error;
      const terminalErrors = await terminalContainerErrors();
      if (terminalErrors.length > 0) {
        throw new Error(terminalErrors.join("\n"), { cause: error });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
    }
  }
  throw new Error(`Cloudflare container did not become ready: ${String(lastError)}`);
}

async function waitForWorkerResponse(
  url: string,
  init: RequestInit,
  expectedStatus: number,
): Promise<Response> {
  const deadline = Date.now() + 120_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await fetch(url, init);
    lastStatus = response.status;
    if (response.status === expectedStatus) return response;
    if (!isCloudflareWorkerRoutePending(response.status)) {
      throw new Error(
        `Cloudflare certification route returned ${response.status}; expected ${expectedStatus}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(
    `Cloudflare certification route did not propagate to ${expectedStatus}; last status ${lastStatus}`,
  );
}

afterAll(async () => {
  if (!live) return;
  const cleanupErrors: unknown[] = [];
  try {
    await deleteResources().catch((error) => cleanupErrors.push(error));
    await deleteR2Bucket().catch((error) => cleanupErrors.push(error));
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Cloudflare certification cleanup failed");
  }
}, 300_000);

suite("Cloudflare live managed runtime certification", () => {
  beforeAll(async () => {
    await createR2Bucket();
    await createIsolatedConfig();
  }, 180_000);

  test("persists across requests, destroys state, and leaks no resources", async () => {
    expect(await listOwnedContainerApplications()).toEqual([]);
    const workerUrl = await deployWithRetry();

    const unauthorized = await waitForWorkerResponse(workerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "read", sandbox_id: sandboxId }),
    }, 401);
    expect(unauthorized.status).toBe(401);
    const invalid = await waitForWorkerResponse(workerUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${nonce}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "read", sandbox_id: "../../shared" }),
    }, 400);
    expect(invalid.status).toBe(400);

    expect((await waitForCreate(workerUrl)).marker).toBe(`${sandboxId}:persisted`);

    const resumed = await invoke(workerUrl, "read");
    expect(resumed.content).toBe(`${sandboxId}:persisted`);
    expect(resumed.command).toContain(`${sandboxId}:persisted`);
    await expect(invoke(workerUrl, "renew_lease")).resolves.toMatchObject({ renewed: true });

    if (r2Live) {
      const checkpointed = await invoke(workerUrl, "checkpoint");
      expect(checkpointed.checkpoint).toMatchObject({
        provider: "cloudflare",
        kind: "filesystem",
        scope: "portable",
      });
      const checkpointId = (checkpointed.checkpoint as { checkpointId?: unknown }).checkpointId;
      expect(checkpointId).toMatch(/^[0-9a-f-]{36}$/);
      r2BackupIds.add(checkpointId as string);
      await expect(invoke(workerUrl, "destroy")).resolves.toMatchObject({ destroyed: true });
      const restored = await invoke(workerUrl, "restore", {
        checkpoint: checkpointed.checkpoint,
      });
      expect(restored).toMatchObject({ restored: true, content: `${sandboxId}:persisted` });
    }

    await expect(invoke(workerUrl, "attach_proxy")).resolves.toMatchObject({ attached: true });
    const proxied = await invoke(workerUrl, "proxy");
    expect(proxied.processEnvironment).toContain("secret-not-in-process");
    expect(proxied.proxyResponse).toContain('"handled_outside_sandbox":true');
    expect(proxied.proxyResponse).toContain('"worker_secret_available":true');
    expect(proxied.proxyResponse).toContain('"sandbox_sent_authorization":false');
    expect(proxied.proxyResponse).toContain('"fence":"generation-1"');
    expect(proxied.proxyResponse).toContain("200");

    const revoked = await invoke(workerUrl, "revoke_proxy");
    expect(revoked.proxyResponse).toContain("revoked");
    expect(revoked.proxyResponse).toContain("403");

    await expect(invoke(workerUrl, "destroy")).resolves.toMatchObject({ destroyed: true });
    await expect(invoke(workerUrl, "verify_destroyed")).resolves.toMatchObject({ missing: true });
  }, 30 * 60_000);
});
