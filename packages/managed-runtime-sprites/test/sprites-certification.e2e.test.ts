import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createSpritesSandbox,
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
  it("covers lifecycle, files, exec, duplex IO, retained state, and cleanup", async () => {
    expect(token, "SPRITES_TOKEN must be set for live certification").not.toBe("");
    const sessionId = `cert-${randomUUID()}`;
    const name = stableName(sessionId);
    let runtime: SpritesRuntime | undefined;
    let primaryFailure: unknown;
    const module = await import("@fly/sprites");
    const client = new module.SpritesClient(token, { controlMode: true }) as SpritesClientPort;

    try {
      runtime = await stage("create", createSpritesSandbox(
        { sessionId, workdir: "/workspace" },
        { SPRITES_TOKEN: token },
        {
          client,
          createOptions: () => ({
            config: { ramMB: 1024, cpus: 1, storageGB: 5 },
            waitForCapacity: true,
          }),
        },
      ), 60_000);

      expect(runtime.runtimeHandle()).toEqual({ provider: "sprites", runtimeId: name });
      expect(await stage("exec", runtime.exec("printf openma-sprites-ready"))).toBe("openma-sprites-ready");
      await stage("renew provider keepalive", runtime.renewLease({ ttlMs: 90_000 }));
      expect(await stage(
        "verify provider keepalive",
        runtime.exec("sprite-env curl -sS /v1/tasks"),
      )).toContain("openma-runtime");

      await stage("write text", runtime.writeFile("/workspace/certification.txt", "retained-state"));
      await stage("write binary", runtime.writeFileBytes(
        "/workspace/certification.bin",
        new Uint8Array([0, 1, 2, 255]),
      ));
      expect(await stage("read text", runtime.readFile("/workspace/certification.txt"))).toBe("retained-state");
      expect(await stage("read binary", runtime.readFileBytes("/workspace/certification.bin"))).toEqual(new Uint8Array([0, 1, 2, 255]));

      const child = await stage("spawn duplex", runtime.spawnDuplexProcess({
        command: "/bin/sh",
        args: ["-lc", "read value; printf 'duplex:%s' \"$value\""],
        cwd: "/workspace",
      }));
      const writer = child.stdin.getWriter();
      await stage("duplex write", writer.write(new TextEncoder().encode("certified\n")));
      await stage("duplex close", writer.close());
      const [stdout, stderr, exited] = await stage("duplex collect", Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]));
      expect(stdout).toBe("duplex:certified");
      expect(stderr).toBe("");
      expect(exited).toMatchObject({ code: 0 });

      const checkpoint = await stage("suspend", runtime.suspend({ kind: "filesystem" }));
      await stage("resume", runtime.resume(checkpoint));
      expect(await stage(
        "verify keepalive release",
        runtime.exec("sprite-env curl -sS /v1/tasks"),
      )).not.toContain("openma-runtime");
      expect(await stage("read retained text", runtime.readFile("/workspace/certification.txt"))).toBe("retained-state");
    } catch (error) {
      primaryFailure = error;
    } finally {
      if (runtime !== undefined) await stage("destroy", runtime.destroy(), 30_000).catch(() => undefined);
      else await client.deleteSprite(name).catch(() => undefined);
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
