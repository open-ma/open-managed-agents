// BoxRunSandbox — REST adapter for BoxRun (boxlite serve).
//
// BoxRun is BoxLite's HTTP control plane. It runs as a single binary on
// any host with KVM (or macOS Hypervisor.framework) and exposes the
// underlying microVM lifecycle over REST. This adapter lets an OMA
// process *without* KVM access (k8s pod on a managed cluster, fly.io
// machine, etc.) get hardware-isolated sandbox execution by talking to
// a separate BoxRun instance.
//
// Architecture:
//
//   [OMA main-node, no KVM]
//        │ HTTP POST /v1/{prefix}/boxes/{id}/exec
//        ▼
//   [BoxRun, KVM-capable host]
//        │ libkrun in-process
//        ▼
//   [microVM with agent's bash subprocess]
//
// Driver dep: zero — uses globalThis.fetch. The boxlite npm package is
// NOT pulled in here; that's only for the embedded LiteBoxSandbox path.
//
// Operator setup (out of scope for this adapter):
//   1. Run `boxlite serve` (default port 8100) on a host with /dev/kvm
//      or Apple Silicon. Single binary, zero daemon dep.
//   2. Set `SANDBOX_PROVIDER=boxrun BOXRUN_URL=http://boxrun:8100/v1/default`
//      on every OMA pod that should use the shared microVM pool.
//
// API surface (REST → SandboxExecutor):
//   exec        →  POST /boxes/{id}/exec  (start)
//                  GET  /boxes/{id}/executions/{exec_id}  (poll status)
//                  GET  /boxes/{id}/executions/{exec_id}/output (SSE)
//   readFile    →  GET  /boxes/{id}/files?path=...  (tar archive)
//   writeFile*  →  PUT  /boxes/{id}/files?path=...  (tar archive)
//   destroy     →  DELETE /boxes/{id}
//
// Box lifecycle: lazy-create on first exec/readFile/writeFile. The
// configured-but-not-started state from BoxRun's POST /boxes is fine —
// POST /exec auto-starts the VM if needed. Cached `boxId` per-instance.

import type { SandboxExecutor, SandboxFactory } from "../ports";

export interface BoxRunSandboxOptions {
  /** BoxRun base URL with workspace prefix. Example:
   *  `http://boxrun:8100/v1/default`. The trailing `/boxes/...` path is
   *  appended by this adapter. */
  baseUrl: string;
  /** Container image. Default: `node:22-slim`, matches LocalSubprocess
   *  / LiteBox defaults so agent bash scripts behave the same. */
  image?: string;
  /** Optional VM resource limits — passed straight to BoxRun's
   *  CreateBoxRequest. */
  cpus?: number;
  memoryMib?: number;
  /** Optional Bearer token for BoxRun's `/oauth/tokens`-issued auth. If
   *  omitted, no Authorization header is sent (matches the default
   *  no-auth `boxlite serve` setup). */
  bearerToken?: string;
  /** Default exec timeout (s). BoxRun applies it server-side. */
  defaultTimeoutSecs?: number;
  /** Used to name the box for operator visibility — boxes named
   *  `oma-<sessionId>` are easy to spot in `boxlite list`. Optional. */
  sessionId?: string;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class BoxRunSandbox implements SandboxExecutor {
  private boxIdPromise: Promise<string> | null = null;
  private envVars: Record<string, string> = {};
  private logger: NonNullable<BoxRunSandboxOptions["logger"]>;

  constructor(private opts: BoxRunSandboxOptions) {
    if (!opts.baseUrl) throw new Error("BoxRunSandbox: baseUrl required");
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => console.warn(`[boxrun-sandbox] ${msg}`, ctx ?? ""),
      log: (msg) => console.log(`[boxrun-sandbox] ${msg}`),
    };
  }

  // ── core API ─────────────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const boxId = await this.ensureBox();
    // Run via /bin/sh -c so agent's pipe / && / && commands work
    // unchanged. The BoxRun ExecRequest takes command + args; we wrap.
    const startRes = await this.fetch(`/boxes/${boxId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "/bin/sh",
        args: ["-c", command],
        env: this.envVars,
        timeout_seconds: (timeout ?? this.opts.defaultTimeoutSecs ?? 600),
      }),
    });
    if (!startRes.ok) {
      throw new Error(`boxrun exec start failed: ${startRes.status} ${await startRes.text()}`);
    }
    const { execution_id: execId } = (await startRes.json()) as { execution_id: string };

    // Stream stdout+stderr via SSE; collect into one combined string.
    // Output endpoint is SSE: each event has data:{"data":"<base64>"}.
    const outRes = await this.fetch(
      `/boxes/${boxId}/executions/${execId}/output`,
      { headers: { Accept: "text/event-stream" } },
    );
    if (!outRes.ok || !outRes.body) {
      throw new Error(`boxrun exec stream failed: ${outRes.status}`);
    }

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    const reader = outRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Parse SSE: events separated by \n\n; fields are `event: foo\ndata: {...}`.
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (!ev) continue;
        if (ev.type === "stdout" || ev.type === "stderr") {
          const data = base64Decode(String(ev.payload.data ?? ""));
          if (ev.type === "stdout") stdout += data;
          else stderr += data;
        } else if (ev.type === "exit") {
          exitCode = (ev.payload.exit_code as number | undefined) ?? null;
        }
      }
    }

    // Match LocalSubprocess shape: "exit=N\n<stdout>\n[stderr:...]".
    // Same surface the harness already parses.
    let result = `exit=${exitCode ?? "?"}\n${stdout}`;
    if (stderr.trim().length > 0) result += `[stderr:${stderr}]`;
    return result;
  }

  async readFile(path: string): Promise<string> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
      { headers: { Accept: "application/x-tar" } },
    );
    if (!res.ok) {
      throw new Error(`boxrun readFile ${path} failed: ${res.status}`);
    }
    // Extract a single file from tar. BoxRun returns a tar archive even
    // for single-file reads. We unpack just the first regular-file
    // entry — sufficient for the harness's read-one-file pattern. Bigger
    // dir reads should use copyOut at the BoxLite level (separate API).
    const tarBytes = new Uint8Array(await res.arrayBuffer());
    const fileBytes = extractFirstRegularFile(tarBytes);
    return new TextDecoder().decode(fileBytes);
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const boxId = await this.ensureBox();
    // Pack a 1-file tar with the relative basename, upload to dirname.
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "/";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const tar = packSingleFileTar(name, bytes);
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(dir)}&overwrite=true`,
      {
        method: "PUT",
        headers: { "content-type": "application/x-tar" },
        body: tar,
      },
    );
    if (!res.ok) {
      throw new Error(`boxrun writeFile ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Stored locally; merged into every exec request via env field.
    // BoxRun has no per-box global-env API today, so we re-send on each
    // call. Cheap (small map). If this grows large, switch to writing
    // /etc/environment via writeFile + sourcing it.
    this.envVars = { ...this.envVars, ...envVars };
  }

  async destroy(): Promise<void> {
    // Idempotent — DELETE on a never-created box returns 404 which we
    // treat as already-gone. Best-effort: log warnings, don't throw.
    if (!this.boxIdPromise) return;
    let boxId: string;
    try {
      boxId = await this.boxIdPromise;
    } catch {
      this.boxIdPromise = null;
      return;
    }
    try {
      const res = await this.fetch(`/boxes/${boxId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        this.logger.warn(`boxrun destroy non-OK: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(`boxrun destroy error: ${(err as Error).message}`);
    } finally {
      this.boxIdPromise = null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private ensureBox(): Promise<string> {
    if (!this.boxIdPromise) this.boxIdPromise = this.createBox();
    return this.boxIdPromise;
  }

  private async createBox(): Promise<string> {
    const body: Record<string, unknown> = {
      image: this.opts.image ?? "node:22-slim",
    };
    if (this.opts.sessionId) body.name = `oma-${this.opts.sessionId.slice(0, 30)}`;
    if (this.opts.cpus) body.cpus = this.opts.cpus;
    if (this.opts.memoryMib) body.memory_mib = this.opts.memoryMib;
    const res = await this.fetch(`/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`boxrun create failed: ${res.status} ${await res.text()}`);
    }
    const box = (await res.json()) as { box_id: string };
    this.logger.log(`box created ${box.box_id} (${body.image})`);
    return box.box_id;
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (this.opts.bearerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.opts.bearerToken}`);
    }
    return globalThis.fetch(url, { ...init, headers });
  }
}

// ── tiny tar helpers (no dep) ────────────────────────────────────────

interface SseEvent {
  type: string;
  payload: Record<string, unknown>;
}

function parseSseBlock(block: string): SseEvent | null {
  let type = "message";
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try {
    return { type, payload: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function base64Decode(s: string): string {
  // Browser-y; works in Node 22+.
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  return atob(s);
}

/**
 * Pack a single regular file into a USTAR-format tar archive.
 * Just enough format for BoxRun's PUT /files to accept it.
 */
function packSingleFileTar(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  // name (100)
  const nameBytes = enc.encode(name).slice(0, 100);
  header.set(nameBytes, 0);
  // mode (8) — "0000644 \0"
  header.set(enc.encode("0000644 "), 100);
  // uid (8) gid (8) — "0000000 \0" each
  header.set(enc.encode("0000000 "), 108);
  header.set(enc.encode("0000000 "), 116);
  // size (12) — octal, padded with NULs, NUL-terminated
  const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
  header.set(enc.encode(sizeOctal), 124);
  // mtime (12) — current time octal
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
  header.set(enc.encode(mtimeOctal), 136);
  // chksum (8) — fill with spaces first, compute, then write
  for (let i = 148; i < 156; i++) header[i] = 32;
  // typeflag (1) — '0' regular file
  header[156] = 48;
  // magic (6) "ustar\0"
  header.set(enc.encode("ustar\0"), 257);
  // version (2) "00"
  header.set(enc.encode("00"), 263);
  // checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const sumOctal = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(enc.encode(sumOctal), 148);

  // Body padded to 512.
  const padded = Math.ceil(content.length / 512) * 512;
  const out = new Uint8Array(512 + padded + 1024);
  out.set(header, 0);
  out.set(content, 512);
  // Trailing 2 zero blocks already zeroed by Uint8Array default.
  return out;
}

/**
 * Extract the first regular file (typeflag '0' or '\0') from a USTAR
 * tar archive. Returns its byte content. Throws if no regular file
 * found within the first ~20 entries.
 */
function extractFirstRegularFile(tar: Uint8Array): Uint8Array {
  let off = 0;
  for (let i = 0; i < 20 && off + 512 <= tar.length; i++) {
    const header = tar.subarray(off, off + 512);
    // Empty block = end of archive.
    if (header.every((b) => b === 0)) break;
    const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).trim().replace(/\0+$/, "");
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    off += 512;
    if (typeflag === "0" || typeflag === "\0" || header[156] === 0) {
      return tar.subarray(off, off + size);
    }
    off += Math.ceil(size / 512) * 512;
  }
  throw new Error("boxrun readFile: tar archive contained no regular file");
}

// ── Factory (DIP entry point) ───────────────────────────────────────
//
// Host code (apps/main-node) only knows the provider name → import path
// map and never reads BOXRUN_* env vars itself. Each env var the BoxRun
// adapter cares about is read here, in the adapter's own file.

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const baseUrl = env.BOXRUN_URL;
  if (!baseUrl) {
    throw new Error(
      "SANDBOX_PROVIDER=boxrun requires BOXRUN_URL " +
        "(e.g. http://boxrun:8100/v1/default)",
    );
  }
  return new BoxRunSandbox({
    baseUrl,
    image: env.SANDBOX_IMAGE,
    cpus: env.BOXRUN_CPUS ? Number(env.BOXRUN_CPUS) : undefined,
    memoryMib: env.BOXRUN_MEMORY_MIB ? Number(env.BOXRUN_MEMORY_MIB) : undefined,
    bearerToken: env.BOXRUN_TOKEN,
    sessionId: ctx.sessionId,
  });
};
