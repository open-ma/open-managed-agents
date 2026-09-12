import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildVercelFunction } from "../scripts/build-function.mjs";

let firstDirectory: string;
let secondDirectory: string;
let firstOutput: string;
let secondOutput: string;
let firstBuild: Awaited<ReturnType<typeof buildVercelFunction>>;
let secondBuild: Awaited<ReturnType<typeof buildVercelFunction>>;

beforeAll(async () => {
  firstDirectory = await mkdtemp(join(import.meta.dirname, "../.test-build-a-"));
  secondDirectory = await mkdtemp(join(import.meta.dirname, "../.test-build-b-"));
  firstOutput = join(firstDirectory, "api.mjs");
  secondOutput = join(secondDirectory, "api.mjs");
  [firstBuild, secondBuild] = await Promise.all([
    buildVercelFunction({ outputFile: firstOutput }),
    buildVercelFunction({ outputFile: secondOutput }),
  ]);
}, 30_000);

afterAll(async () => {
  await Promise.all([firstDirectory, secondDirectory].map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Vercel Function build", () => {
  it("bundles workspace sources while preserving Vercel's Node dependencies", async () => {
    const source = await readFile(firstOutput, "utf8");
    expect(source).not.toMatch(/(?:from|import\()\s*["']@open-managed-agents\//);
    expect(source).not.toMatch(/(?:from|import\()\s*["']@openma\//);
    expect(source).toContain("@vercel/sandbox");
  });

  it("is byte-for-byte reproducible and reports the artifact checksum", async () => {
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(firstOutput),
      readFile(secondOutput),
    ]);

    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
    expect(firstBuild.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondBuild.sha256).toBe(firstBuild.sha256);
    expect(firstBuild.bytes).toBe(firstBytes.byteLength);
    expect(secondBuild.bytes).toBe(secondBytes.byteLength);
    expect(firstBuild.bytes).toBeLessThan(16_000_000);
  });

  it("loads as a Node ESM handler and fails closed without deployment config", async () => {
    const module = await import(`${pathToFileURL(firstOutput).href}?test=${Date.now()}`) as {
      default: { fetch(request: Request): Promise<Response> | Response };
    };
    const response = await module.default.fetch(new Request(
      "http://localhost/api/openma/environment/poll",
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "cron_not_configured",
    });
  }, 30_000);
});
