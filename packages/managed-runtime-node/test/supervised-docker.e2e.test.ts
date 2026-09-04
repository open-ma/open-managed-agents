import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createNodeManagedRuntime } from "../src/index";

describe("openma_supervised in Docker", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  });

  it("runs the real JSONL supervisor and publishes native state plus outputs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "oma-supervised-docker-"));
    roots.push(rootDir);
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const scope = {
      workspaceId: "workspace_supervised_docker",
      environmentId: "environment_supervised_docker",
      sessionId: "session_supervised_docker",
      workId: "work_supervised_docker",
    };
    const fixture = `
      import { mkdir, writeFile } from "node:fs/promises";
      import { Readable, Writable } from "node:stream";
      import { serveHarnessSupervisorJsonl } from ${JSON.stringify(
        join(repositoryRoot, "packages/harness-supervisor/src/index.ts"),
      )};

      await serveHarnessSupervisorJsonl({
        input: Readable.toWeb(process.stdin),
        output: Writable.toWeb(process.stdout),
        heartbeatIntervalMs: 50,
        resolveHarness: async ({ id, version }) => {
          if (id !== "fixture" || version !== "1") return null;
          return {
            async start(input) {
              const stateDirectory = input.workspacePath
                + "/.openma/harness-state/fixture/"
                + input.scope.sessionId;
              const completed = (async () => {
                await mkdir(stateDirectory, { recursive: true });
                await writeFile(
                  stateDirectory + "/session.jsonl",
                  JSON.stringify({ type: "native.turn", text: "survives" }) + "\\n",
                );
                if (input.outputPath !== null) {
                  await mkdir(input.outputPath, { recursive: true });
                  await writeFile(input.outputPath + "/answer.txt", "supervised output");
                }
                return { exitCode: 0 };
              })();
              return {
                completed,
                async drain() {
                  await writeFile(stateDirectory + "/drained", "yes");
                },
                async stop(reason) {
                  await writeFile(stateDirectory + "/stopped", reason);
                },
              };
            },
          };
        },
      });
    `;
    const fixtureSource = join(rootDir, "supervisor-fixture.ts");
    const fixtureBundle = join(rootDir, "supervisor-fixture.mjs");
    await writeFile(fixtureSource, fixture);
    await promisify(execFile)(join(repositoryRoot, "node_modules/.bin/esbuild"), [
      fixtureSource,
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=node24",
      `--outfile=${fixtureBundle}`,
    ]);
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const runtime = await createNodeManagedRuntime({
      rootDir,
      sql,
      initializeFenceSchema: true,
      ownerId: "supervised-docker-host",
      leaseTtlMs: 10_000,
      heartbeatIntervalMs: 100,
      image: process.env.OMA_RUNTIME_NODE_IMAGE ?? "node:24-alpine",
      additionalMounts: [{
        source: rootDir,
        destination: "/opt/openma-fixture",
        readOnly: true,
      }],
    });

    await expect(runtime.host.run({
      scope,
      profile: {
        workspace: { requirement: "durable" },
        outputs: { requirement: "durable" },
        runtimeCheckpoint: "disabled",
        driver: {
          type: "openma_supervised",
          protocol: "openma-harness-supervisor-v1",
          supervisor: {
            command: "/usr/local/bin/node",
            args: ["/opt/openma-fixture/supervisor-fixture.mjs"],
          },
          harness: { id: "fixture", version: "1" },
          readyTimeoutMs: 5_000,
          heartbeatTimeoutMs: 5_000,
          drainTimeoutMs: 5_000,
        },
      },
    })).resolves.toEqual({ type: "completed", revision: 1 });

    const verifier = await runtime.fences.acquire({
      scope,
      ownerId: "supervised-docker-verifier",
      ttlMs: 10_000,
    });
    if (verifier.type !== "acquired" || verifier.publication === null) {
      throw new Error("expected supervised runtime publication");
    }
    const restored = await runtime.workspace.materialize({
      scope,
      fence: verifier.fence,
      strategy: "checkpoint_restore",
      activeCheckpoint: verifier.publication.workspaceCandidate,
      idempotencyKey: "verify-supervised-state",
      signal: new AbortController().signal,
    });
    const stateDirectory = String(restored.metadata?.hostPath)
      + `/.openma/harness-state/fixture/${scope.sessionId}`;
    await expect(readFile(`${stateDirectory}/session.jsonl`, "utf8"))
      .resolves.toBe('{"type":"native.turn","text":"survives"}\n');
    await expect(readFile(`${stateDirectory}/drained`, "utf8")).resolves.toBe("yes");
    await expect(readFile(`${stateDirectory}/stopped`, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const manifestHash = verifier.publication.outputCandidate!.contentHash
      .slice("sha256:".length);
    const manifest = JSON.parse(await readFile(
      join(rootDir, "outputs", "manifests", `${manifestHash}.json`),
      "utf8",
    ));
    expect(manifest.entries).toEqual([
      expect.objectContaining({ logicalPath: "answer.txt", size: 17 }),
    ]);
  });
});
