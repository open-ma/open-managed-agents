// Smoke test for POST /v1/sessions/:id/files (sandbox path → file_id
// promotion) on Node.
//
// Spawns main-node, creates a tenant + agent + session, writes a file
// inside the sandbox via /exec, then calls /sessions/:id/files. Verifies
// the response is 201 with a valid file_id, and that GET /v1/files/:id
// returns the metadata.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

async function startMainNode(opts: { dataDir: string }): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch { /* not ready */ }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else rej(new Error("could not pick port"));
    });
  });
}

describe("Node POST /v1/sessions/:id/files (promoteSandboxFile)", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-files-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns 201 with a valid file_id and GET round-trips", async () => {
    h = await startMainNode({ dataDir });
    const base = `http://localhost:${h.port}/v1`;

    // 1. Create an agent (so the session has something to bind to).
    const aRes = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-agent", model: "claude-haiku-4-5-20251001" }),
    });
    expect(aRes.status).toBe(201);
    const agent = (await aRes.json()) as { id: string };

    // 2. Create a session. Body shape mirrors apps/main:
    //    { agent: <id>, environment?: <id> } — environment defaults to
    //    `env_local_runtime` when an agent has a runtime_binding (Node has
    //    no cloud env_id concept yet, so loadEnvironment is unset and the
    //    request falls through with environment=null).
    const sRes = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: agent.id, environment: "env_local_runtime" }),
    });
    if (sRes.status !== 201) {
      const body = await sRes.text();
      throw new Error(`session create expected 201; got ${sRes.status} ${body}`);
    }
    const session = (await sRes.json()) as { id: string };

    // 3. Write a file inside the sandbox via /exec. LocalSubprocess
    //    has cwd = workdir, so a bare relative path lands in the workdir
    //    which `readSandboxFile("/workspace/greeting.txt")` then resolves
    //    via the harness's /workspace → workdir mapping.
    const writeRes = await fetch(`${base}/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "printf 'hello-from-sandbox' > greeting.txt",
        timeout_ms: 30_000,
      }),
    });
    expect(writeRes.status).toBe(200);

    // 4. Promote /workspace/greeting.txt to a file_id.
    const promoteRes = await fetch(`${base}/sessions/${session.id}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/workspace/greeting.txt",
        filename: "greeting.txt",
        media_type: "text/plain",
        downloadable: true,
      }),
    });
    if (promoteRes.status !== 201) {
      const body = await promoteRes.text();
      throw new Error(`promoteSandboxFile expected 201; got ${promoteRes.status} ${body}`);
    }
    const fileRecord = (await promoteRes.json()) as { id: string; type: string };
    expect(fileRecord.type).toBe("file");
    expect(fileRecord.id).toMatch(/^file-/);

    // 5. GET /v1/files/:id returns the same metadata.
    const getRes = await fetch(`${base}/files/${fileRecord.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string; filename: string };
    expect(fetched.id).toBe(fileRecord.id);
    expect(fetched.filename).toBe("greeting.txt");

    // 6. GET /v1/files/:id/content returns the bytes.
    const contentRes = await fetch(`${base}/files/${fileRecord.id}/content`);
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe("hello-from-sandbox");
  }, 60_000);
});
