import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createSpritesProvider,
  type SpritesClientPort,
  type SpritesRuntime,
} from "../src/sprites";

const enabled = process.env.OMA_SPRITES_CERTIFICATION === "1";
const token = process.env.SPRITES_TOKEN ?? "";

function stableName(sessionId: string): string {
  return `oma-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

async function stage<T>(label: string, task: Promise<T>, timeoutMs = 30_000): Promise<T> {
  console.info(`[sprites-live] ${label}: start`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    console.info(`[sprites-live] ${label}: pass`);
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe.runIf(enabled)("Sprites live certification", () => {
  it("covers create, exec, duplex IO, retained filesystem reattach, and cleanup", async () => {
    expect(token, "SPRITES_TOKEN must be set for live certification").not.toBe("");
    const sessionId = `cert-${randomUUID()}`;
    const name = stableName(sessionId);
    const scope = {
      workspaceId: "sprites-live-certification",
      environmentId: "sprites-live-certification",
      sessionId,
      workId: `work-${randomUUID()}`,
    };
    const fence = {
      ...scope,
      ownerId: "sprites-live-certification",
      generation: 1,
      token: "not-a-runtime-secret",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    const plan = {
      workspaceStrategy: "retained_runtime" as const,
      outputStrategy: null,
      runtimeCheckpoint: null,
      driver: { type: "ama_worker" as const, process: { command: "true" } },
    };
    const context = { sessionId, workdir: "/workspace" };
    const module = await import("@fly/sprites");
    const client = new module.SpritesClient(token, { controlMode: true }) as SpritesClientPort;
    const provider = createSpritesProvider({
      client,
      createOptions: () => ({
        config: { ramMB: 1024, cpus: 1, storageGB: 5 },
        waitForCapacity: true,
      }),
    });
    const acquisition = {
      scope,
      fence,
      plan,
      workspace: { bindingId: `workspace-${sessionId}`, mountPath: "/workspace" as const },
      outputs: null,
      credentialEgress: null,
      signal: new AbortController().signal,
    };
    let runtime: SpritesRuntime | undefined;
    let resumed: SpritesRuntime | undefined;
    let primaryFailure: unknown;

    try {
      runtime = await stage("create", provider.create(context, {}, acquisition), 60_000);
      expect(runtime.runtimeHandle()).toEqual({ provider: "sprites", runtimeId: name });
      expect(await stage("exec", runtime.exec("printf openma-sprites-ready"))).toBe("openma-sprites-ready");
      await stage("write", runtime.writeFile("/workspace/certification.txt", "retained-state"));

      const child = await stage("spawn duplex", runtime.spawnDuplexProcess({
        command: "/bin/sh",
        args: ["-lc", "read value; printf 'duplex:%s' \"$value\""],
        cwd: "/workspace",
      }));
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("certified\n"));
      await writer.close();
      const [stdout, stderr, exited] = await stage("collect duplex", Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]));
      expect(stdout).toBe("duplex:certified");
      expect(stderr).toBe("");
      expect(exited).toMatchObject({ code: 0 });

      const handle = runtime.runtimeHandle();
      await stage("suspend", runtime.suspend({ kind: "filesystem" }));
      resumed = await stage("reattach", provider.resume(handle, context, {}, acquisition), 60_000);
      expect(await stage("read retained", resumed.readFile("/workspace/certification.txt"))).toBe("retained-state");
    } catch (error) {
      primaryFailure = error;
    } finally {
      await stage("destroy", (resumed ?? runtime)?.destroy() ?? client.deleteSprite(name), 30_000)
        .catch(() => undefined);
      let cleanupFailure: unknown;
      try {
        await expect(stage("verify cleanup", client.getSprite(name))).rejects.toMatchObject({ statusCode: 404 });
      } catch (error) {
        cleanupFailure = error;
      }
      if (primaryFailure !== undefined) throw primaryFailure;
      if (cleanupFailure !== undefined) throw cleanupFailure;
    }
  }, 180_000);
});
