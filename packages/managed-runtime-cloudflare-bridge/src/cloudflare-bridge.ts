import type { BlobStore } from "@open-managed-agents/blob-store/ports";
import type {
  ManagedRuntimeProviderDriverPort,
  SessionInputMaterializerPort,
} from "@open-managed-agents/runtime-resource-contract";
import type {
  SandboxCheckpointHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";

import {
  createProviderManagedRuntime,
  type ProviderManagedRuntimeOptions,
} from "@open-managed-agents/managed-runtime-sandbox";

const providerName = "cloudflare-sandbox-bridge";
const defaultMaxHydrateBytes = 32 * 1024 * 1024;

type BridgeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareBridgeProviderOptions {
  /** URL of the operator-deployed official Cloudflare Sandbox Bridge Worker. */
  baseUrl: string;
  /** SANDBOX_API_KEY configured on that Bridge. It never enters the sandbox. */
  apiKey: string;
  /** Durable storage for portable `/workspace` tar archives. */
  checkpointStore: BlobStore;
  checkpointKeyPrefix?: string;
  checkpointExcludes?: readonly string[];
  maxHydrateBytes?: number;
  fetch?: BridgeFetch;
}

export interface CloudflareBridgeManagedRuntimeOptions
  extends CloudflareBridgeProviderOptions {
  leaseTtlMs: number;
  outputStore?: BlobStore | null;
  outputKeyPrefix?: string;
  readiness?: ProviderManagedRuntimeOptions<CloudflareBridgeRuntime>["readiness"];
  /** Operator-owned staging for official Session file/repository/memory inputs. */
  sessionInputs?: SessionInputMaterializerPort;
}

interface BridgeCheckpointMetadata {
  blobKey: string;
  contentHash: string;
  size: number;
}

function safePrefix(value: string | undefined): string {
  const normalized = (value ?? "cloudflare-bridge-workspaces").replace(/^\/+|\/+$/g, "");
  if (normalized === "" || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Cloudflare Bridge checkpoint prefix must be safe and non-empty");
  }
  return normalized;
}

function safeWorkspacePath(path: string): string {
  const normalized = path.replace(/\/{2,}/g, "/");
  if (!normalized.startsWith("/workspace/")) {
    throw new Error("Cloudflare Bridge file paths must resolve within /workspace");
  }
  const relative = normalized.slice("/workspace/".length);
  if (
    relative === ""
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Cloudflare Bridge file path is unsafe");
  }
  return relative;
}

function safeWorkspaceDirectory(path: string | undefined): string {
  const normalized = (path ?? "/workspace").replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
  if (
    normalized !== "/workspace"
    && !normalized.startsWith("/workspace/")
  ) {
    throw new Error("Cloudflare Bridge cwd must resolve within /workspace");
  }
  if (normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Cloudflare Bridge cwd is unsafe");
  }
  return normalized;
}

function safeOutputPath(path: string): string {
  const root = "/mnt/session/outputs/";
  if (!path.startsWith(root)) {
    throw new Error("Cloudflare Bridge non-workspace reads are limited to Session outputs");
  }
  const relative = path.slice(root.length);
  if (
    relative === ""
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Cloudflare Bridge Session output path is unsafe");
  }
  return path;
}

function encodeWorkspacePath(path: string): string {
  return safeWorkspacePath(path).split("/").map(encodeURIComponent).join("/");
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(
    `Cloudflare Sandbox Bridge ${response.status}${body === "" ? "" : `: ${body}`}`,
  );
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const parseLine = (line: string) => {
    if (line.startsWith("event:")) event = line.slice("event:".length).trimStart();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  };
  try {
    for (;;) {
      const next = await reader.read();
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else {
          parseLine(line);
        }
      }
      if (next.done) break;
    }
    if (buffer !== "") parseLine(buffer.replace(/\r$/, ""));
    if (data.length > 0) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

function checkpointMetadata(checkpoint: SandboxCheckpointHandle): BridgeCheckpointMetadata {
  const metadata = checkpoint.metadata;
  const blobKey = metadata?.blobKey;
  const contentHash = metadata?.contentHash;
  const size = metadata?.size;
  if (
    checkpoint.provider !== providerName
    || checkpoint.kind !== "filesystem"
    || checkpoint.scope !== "portable"
    || typeof blobKey !== "string"
    || blobKey === ""
    || typeof contentHash !== "string"
    || !contentHash.startsWith("sha256:")
    || typeof size !== "number"
    || !Number.isSafeInteger(size)
    || size < 0
  ) {
    throw new Error("Incompatible Cloudflare Bridge workspace checkpoint");
  }
  return { blobKey, contentHash, size };
}

export class CloudflareBridgeRuntime
  implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #runtimeId: string;
  readonly #store: BlobStore;
  readonly #prefix: string;
  readonly #excludes: readonly string[];
  readonly #maxHydrateBytes: number;
  readonly #fetch: BridgeFetch;
  #destroyed = false;
  #destroyPromise: Promise<void> | null = null;

  constructor(input: CloudflareBridgeProviderOptions & { runtimeId: string }) {
    this.#baseUrl = input.baseUrl.replace(/\/+$/g, "");
    this.#apiKey = input.apiKey;
    this.#runtimeId = input.runtimeId;
    this.#store = input.checkpointStore;
    this.#prefix = safePrefix(input.checkpointKeyPrefix);
    this.#excludes = input.checkpointExcludes ?? [];
    this.#maxHydrateBytes = input.maxHydrateBytes ?? defaultMaxHydrateBytes;
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis);
    if (this.#baseUrl === "" || this.#apiKey === "" || this.#runtimeId === "") {
      throw new Error("Cloudflare Bridge baseUrl, apiKey, and runtimeId are required");
    }
    if (!Number.isSafeInteger(this.#maxHydrateBytes) || this.#maxHydrateBytes <= 0) {
      throw new RangeError("Cloudflare Bridge maxHydrateBytes must be a positive integer");
    }
  }

  runtimeHandle() {
    return { provider: providerName, runtimeId: this.#runtimeId };
  }

  runtimeCapabilities() {
    return { lease: false, suspend: [], checkpoint: ["filesystem" as const] };
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.#apiKey}`);
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/sandbox/${encodeURIComponent(this.#runtimeId)}${path}`,
      { ...init, headers },
    );
    return response;
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (this.#destroyed) return "stopped";
    const response = await this.#request("/running");
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { running?: unknown };
    return body.running === true ? "running" : "stopped";
  }

  async renewLease(): Promise<void> {
    if (await this.status() !== "running") {
      throw new Error("Cloudflare Bridge sandbox is not running");
    }
  }

  async suspend(): Promise<SandboxCheckpointHandle> {
    throw new Error("Cloudflare Sandbox Bridge does not expose runtime suspension");
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    await this.#hydrate(checkpointMetadata(checkpoint));
  }

  async checkpoint(input: { kind: "filesystem" | "memory"; name?: string }) {
    if (input.kind !== "filesystem") {
      throw new Error("Cloudflare Sandbox Bridge only supports filesystem checkpoints");
    }
    const excludes = this.#excludes.length === 0
      ? ""
      : `?excludes=${encodeURIComponent(this.#excludes.join(","))}`;
    const response = await this.#request(`/persist${excludes}`, { method: "POST" });
    if (!response.ok) throw await responseError(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#maxHydrateBytes) {
      throw new Error(
        `Cloudflare Bridge workspace archive exceeds hydrate limit (${this.#maxHydrateBytes})`,
      );
    }
    const hash = await sha256(bytes);
    const name = (input.name ?? hash).replace(/[^A-Za-z0-9._-]/g, "-");
    const blobKey = `${this.#prefix}/${encodeURIComponent(this.#runtimeId)}/${name}-${hash}.tar`;
    const stored = await this.#store.put(blobKey, bytes, {
      httpMetadata: { contentType: "application/x-tar" },
      customMetadata: { sha256: hash, runtimeId: this.#runtimeId },
      precondition: { type: "ifNoneMatch", value: "*" },
    });
    if (stored === null) {
      const existing = await this.#store.get(blobKey);
      if (
        existing === null
        || existing.size !== bytes.byteLength
        || await sha256(await existing.bytes()) !== hash
      ) {
        throw new Error("Cloudflare Bridge checkpoint storage collision");
      }
    }
    return {
      provider: providerName,
      checkpointId: `sha256:${hash}`,
      sourceRuntimeId: this.#runtimeId,
      kind: "filesystem" as const,
      scope: "portable" as const,
      metadata: {
        blobKey,
        contentHash: `sha256:${hash}`,
        size: bytes.byteLength,
      },
    } satisfies SandboxCheckpointHandle;
  }

  async #hydrate(metadata: BridgeCheckpointMetadata): Promise<void> {
    if (metadata.size > this.#maxHydrateBytes) {
      throw new Error("Cloudflare Bridge checkpoint exceeds hydrate limit");
    }
    const object = await this.#store.get(metadata.blobKey);
    if (object === null || object.size !== metadata.size) {
      throw new Error("Cloudflare Bridge checkpoint archive is missing or has the wrong size");
    }
    const bytes = await object.bytes();
    if (`sha256:${await sha256(bytes)}` !== metadata.contentHash) {
      throw new Error("Cloudflare Bridge checkpoint archive hash mismatch");
    }
    const response = await this.#request("/hydrate", {
      method: "POST",
      headers: { "content-type": "application/x-tar" },
      body: bytes,
    });
    if (!response.ok) throw await responseError(response);
  }

  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const abort = new AbortController();
    const stdout = new TransformStream<Uint8Array, Uint8Array>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();
    const stdoutWriter = stdout.writable.getWriter();
    const stderrWriter = stderr.writable.getWriter();
    const env = Object.entries(spec.env ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    const argv = env.length === 0
      ? [spec.command, ...(spec.args ?? [])]
      : ["env", ...env.map(([key, value]) => `${key}=${value}`), spec.command, ...(spec.args ?? [])];
    const response = await this.#request("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        argv,
        cwd: safeWorkspaceDirectory(spec.cwd),
      }),
      signal: abort.signal,
    });
    if (!response.ok || response.body === null) throw await responseError(response);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Cloudflare Bridge exec did not return an SSE stream");
    }
    let killedSignal: "SIGTERM" | "SIGKILL" | null = null;
    const exited = (async () => {
      try {
        for await (const message of parseSse(response.body!)) {
          if (message.event === "stdout") {
            await stdoutWriter.write(decodeBase64(message.data));
          } else if (message.event === "stderr") {
            await stderrWriter.write(decodeBase64(message.data));
          } else if (message.event === "exit") {
            const payload = JSON.parse(message.data) as { exit_code?: unknown };
            if (!Number.isSafeInteger(payload.exit_code)) {
              throw new Error("Cloudflare Bridge exec returned an invalid exit event");
            }
            return { code: Number(payload.exit_code), signal: null };
          } else if (message.event === "error") {
            const payload = JSON.parse(message.data) as { error?: unknown; code?: unknown };
            throw new Error(
              `Cloudflare Bridge exec error${
                typeof payload.code === "string" ? ` (${payload.code})` : ""
              }: ${String(payload.error ?? "unknown")}`,
            );
          }
        }
        if (killedSignal !== null) {
          return { code: null, signal: killedSignal };
        }
        throw new Error("Cloudflare Bridge exec stream ended without a terminal event");
      } catch (error) {
        if (killedSignal !== null) {
          return { code: null, signal: killedSignal };
        }
        throw error;
      } finally {
        await Promise.allSettled([
          stdoutWriter.close(),
          stderrWriter.close(),
        ]);
      }
    })();
    return {
      stdin: new WritableStream<Uint8Array>({
        write() {
          throw new Error("Cloudflare Bridge exec has no stdin; use the PTY API for interactive processes");
        },
      }),
      stdout: stdout.readable,
      stderr: stderr.readable,
      async kill(signal = "SIGTERM") {
        killedSignal = signal;
        abort.abort(new DOMException(`Process killed with ${signal}`, "AbortError"));
      },
      exited,
    };
  }

  async #execute(
    argv: readonly string[],
    input: { cwd: string; timeoutMs?: number },
  ): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    const response = await this.#request("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        argv,
        ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
        cwd: safeWorkspaceDirectory(input.cwd),
      }),
    });
    if (!response.ok || response.body === null) throw await responseError(response);
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("Cloudflare Bridge exec did not return an SSE stream");
    }
    const output: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    let exitCode: number | null = null;
    for await (const message of parseSse(response.body)) {
      if (message.event === "stdout") output.push(decodeBase64(message.data));
      if (message.event === "stderr") errors.push(decodeBase64(message.data));
      if (message.event === "exit") {
        const payload = JSON.parse(message.data) as { exit_code?: unknown };
        if (!Number.isSafeInteger(payload.exit_code)) {
          throw new Error("Cloudflare Bridge exec returned an invalid exit event");
        }
        exitCode = Number(payload.exit_code);
      }
      if (message.event === "error") {
        const payload = JSON.parse(message.data) as { error?: unknown; code?: unknown };
        throw new Error(
          `Cloudflare Bridge exec failed${
            typeof payload.code === "string" ? ` (${payload.code})` : ""
          }: ${String(payload.error ?? "unknown")}`,
        );
      }
    }
    if (exitCode === null) throw new Error("Cloudflare Bridge exec stream ended without an exit event");
    return { stdout: joinBytes(output), stderr: joinBytes(errors), exitCode };
  }

  async exec(command: string, timeout = 10_000): Promise<string> {
    const result = await this.#execute(["sh", "-lc", command], {
      cwd: "/workspace",
      timeoutMs: timeout,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Cloudflare Bridge command exited with ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
    return new TextDecoder().decode(result.stdout);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    if (path.startsWith("/mnt/")) {
      const result = await this.#execute(
        ["base64", "-w", "0", safeOutputPath(path)],
        { cwd: "/workspace" },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `Cloudflare Bridge output read exited with ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
      return decodeBase64(new TextDecoder().decode(result.stdout).replace(/\s+/g, ""));
    }
    const response = await this.#request(`/file/${encodeWorkspacePath(path)}`);
    if (!response.ok) throw await responseError(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const response = await this.#request(`/file/${encodeWorkspacePath(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    if (!response.ok) throw await responseError(response);
    return path;
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    if (this.#destroyPromise !== null) return this.#destroyPromise;
    const operation = (async () => {
      const response = await this.#request("", { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw await responseError(response);
      this.#destroyed = true;
    })();
    this.#destroyPromise = operation;
    try {
      await operation;
    } finally {
      if (!this.#destroyed) this.#destroyPromise = null;
    }
  }
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createCloudflareBridgeProvider(
  options: CloudflareBridgeProviderOptions,
): SandboxProviderPort<CloudflareBridgeRuntime> {
  const baseUrl = options.baseUrl.replace(/\/+$/g, "");
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const requestRoot = async (init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${options.apiKey}`);
    return fetch(`${baseUrl}/v1/sandbox`, { ...init, headers });
  };
  const attach = (runtimeId: string) => new CloudflareBridgeRuntime({
    ...options,
    baseUrl,
    fetch,
    runtimeId,
  });
  const create = async () => {
    const response = await requestRoot({ method: "POST" });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { id?: unknown };
    if (typeof body.id !== "string" || body.id === "") {
      throw new Error("Cloudflare Sandbox Bridge returned an invalid sandbox id");
    }
    return attach(body.id);
  };
  return {
    create,
    async resume(handle) {
      if (handle.provider !== providerName || handle.runtimeId === "") {
        throw new Error("Incompatible Cloudflare Bridge runtime handle");
      }
      return attach(handle.runtimeId);
    },
    async restore(checkpoint) {
      checkpointMetadata(checkpoint);
      const runtime = await create();
      try {
        await runtime.resume(checkpoint);
        return runtime;
      } catch (error) {
        await Promise.allSettled([runtime.destroy()]);
        throw error;
      }
    },
  };
}

export function createCloudflareBridgeManagedRuntime(
  options: CloudflareBridgeManagedRuntimeOptions,
) {
  const provider = createCloudflareBridgeProvider(options);
  return createProviderManagedRuntime({
    providerName,
    provider,
    context: (scope): SandboxFactoryContext => ({
      sessionId: scope.sessionId,
      workdir: "/workspace",
    }),
    environment: (): SandboxFactoryEnv => ({}),
    leaseTtlMs: options.leaseTtlMs,
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    sandboxCapabilities: {
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    },
    workspace: {
      strategies: ["checkpoint_restore"],
      portableCheckpointKind: "filesystem",
    },
    ...(options.outputStore === undefined || options.outputStore === null
      ? {}
      : {
          outputs: {
            store: options.outputStore,
            keyPrefix: options.outputKeyPrefix ?? "cloudflare-bridge-output-candidates",
            durability: "durable" as const,
          },
        }),
    drivers: ["ama_worker"],
  });
}

/** Provider-driver projection for an operator-deployed official Sandbox
 * Bridge. The Bridge credential and HTTP client never cross this Port. */
export function createCloudflareBridgeManagedRuntimeDriver(
  options: CloudflareBridgeManagedRuntimeOptions,
): ManagedRuntimeProviderDriverPort {
  const hasOutputStore = options.outputStore !== undefined && options.outputStore !== null;
  return {
    descriptor() {
      return {
        provider: "cloudflare-bridge",
        version: "1.0.0",
        placements: ["driver_service"],
        capabilities: {
          sandbox: {
            suspendResume: "unsupported",
            hardTerminate: "supported",
            runtimeCheckpoints: [],
          },
          workspace: { strategies: ["checkpoint_restore"] },
          outputs: {
            strategies: hasOutputStore
              ? [{ strategy: "final_collect", durability: "durable" }]
              : [],
          },
          harness: { drivers: ["ama_worker"] },
        },
        credentialEgress: {
          enforcement: "unsupported",
          credentialMode: "snapshot",
          interceptedProtocols: [],
        },
      };
    },
    async create(input) {
      if (input.placement !== "driver_service") {
        throw new Error(
          `Cloudflare Sandbox Bridge does not support ${input.placement} placement`,
        );
      }
      const runtime = createCloudflareBridgeManagedRuntime(options);
      return {
        sandbox: runtime.sandbox,
        workspace: runtime.workspace,
        outputs: runtime.outputs,
        harnessDriver: runtime.harness,
        ...(options.sessionInputs === undefined
          ? {}
          : { sessionInputs: options.sessionInputs }),
      };
    },
  };
}
