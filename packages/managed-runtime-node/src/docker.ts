import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  HarnessSupervisorChannel,
  HarnessSupervisorCommand,
  HarnessSupervisorEvent,
  HarnessSupervisorTransportPort,
  ManagedSandboxLease,
  ManagedSandboxPort,
  SandboxHarnessDriverPort,
  SandboxObservation,
} from "@open-managed-agents/runtime-resource-contract";

import { safeMetadataPath, sha256 } from "./filesystem";

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerCommandPort {
  run(
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<DockerCommandResult>;
  spawnDuplex?(args: readonly string[]): DockerDuplexProcess;
}

export interface DockerDuplexProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export class DockerCliPort implements DockerCommandPort {
  constructor(private readonly executable = "docker") {}

  run(
    args: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<DockerCommandResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const child = spawn(this.executable, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const onAbort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  spawnDuplex(args: readonly string[]): DockerDuplexProcess {
    const child = spawn(this.executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    return {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
      exited,
      async kill(signal = "SIGTERM") {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    };
  }
}

export interface DockerManagedRuntimeOptions {
  image: string;
  network?: string;
  docker?: DockerCommandPort;
  /** Operator-owned mounts shared by every runtime container (for example a
   * preinstalled worker SDK). Session workspace/output bindings remain owned
   * by their dedicated Ports and are added separately. */
  additionalMounts?: readonly {
    source: string;
    destination: string;
    readOnly?: boolean;
  }[];
  /** Explicit host aliases used by local/self-hosted control planes. */
  extraHosts?: readonly { hostname: string; address: string }[];
}

/**
 * Real Docker Engine transport for the reference Node runtime. The host owns
 * lifecycle/fencing; this adapter only creates, observes, starts and destroys
 * one container with the already-materialized resource bindings.
 */
export class DockerManagedRuntimeAdapter
  implements ManagedSandboxPort, SandboxHarnessDriverPort, HarnessSupervisorTransportPort
{
  readonly #docker: DockerCommandPort;
  readonly #options: DockerManagedRuntimeOptions;
  readonly #known = new Set<string>();

  constructor(options: DockerManagedRuntimeOptions) {
    this.#options = options;
    this.#docker = options.docker ?? new DockerCliPort();
  }

  async capabilities() {
    return {
      suspendResume: "unsupported",
      hardTerminate: "supported",
      runtimeCheckpoints: [],
    } as const;
  }

  async driverCapabilities() {
    return { drivers: ["ama_worker"] as const };
  }

  async acquire(
    input: Parameters<ManagedSandboxPort["acquire"]>[0],
  ): Promise<ManagedSandboxLease> {
    input.signal.throwIfAborted();
    const workspace = this.#mount(
      safeMetadataPath(input.workspace.metadata?.hostPath, "workspace binding"),
      input.workspace.mountPath,
    );
    const args = [
      "create",
      "--name",
      `oma-${sha256(`${input.scope.workId}:${input.fence.generation}`).slice(0, 24)}`,
      "--label",
      `dev.openma.work=${sha256(input.scope.workId).slice(0, 32)}`,
      "--mount",
      workspace,
    ];
    if (input.outputs !== null) {
      args.push(
        "--mount",
        this.#mount(
          safeMetadataPath(input.outputs.metadata?.hostPath, "output binding"),
          input.outputs.mountPath,
        ),
      );
    }
    for (const mount of this.#options.additionalMounts ?? []) {
      args.push(
        "--mount",
        this.#mount(mount.source, mount.destination, mount.readOnly === true),
      );
    }
    for (const host of this.#options.extraHosts ?? []) {
      if (host.hostname.includes(":") || host.address.length === 0) {
        throw new Error("Docker host aliases require a hostname without ':' and an address");
      }
      args.push("--add-host", `${host.hostname}:${host.address}`);
    }
    if (this.#options.network !== undefined) {
      args.push("--network", this.#options.network);
    }
    const process = input.plan.driver.type === "ama_worker"
      ? input.plan.driver.process
      : input.plan.driver.supervisor;
    if (input.plan.driver.type === "openma_supervised") {
      // Keep stdin open so the host can attach the JSONL supervisor channel
      // after the workspace/output transaction has completed.
      args.push("--interactive");
    }
    if (process.cwd !== undefined) args.push("--workdir", process.cwd);
    for (const [name, value] of Object.entries(process.env ?? {})) {
      args.push("--env", `${name}=${value}`);
    }
    args.push("--entrypoint", process.command);
    args.push(this.#options.image, ...(process.args ?? []));
    const result = await this.#docker.run(args, { signal: input.signal });
    if (result.exitCode !== 0) {
      throw new Error(`docker create failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    const runtimeId = result.stdout.trim();
    if (runtimeId.length === 0) throw new Error("docker create returned no container id");
    this.#known.add(runtimeId);
    return { provider: "docker", runtimeId };
  }

  async heartbeat(input: Parameters<ManagedSandboxPort["heartbeat"]>[0]) {
    const observation = await this.inspect(input.lease);
    return observation.state === "running" || observation.state === "suspended"
      ? ({ type: "alive" } as const)
      : ({ type: "lost" } as const);
  }

  async suspend(
    _input: Parameters<ManagedSandboxPort["suspend"]>[0],
  ): Promise<ManagedSandboxLease> {
    throw new Error("Docker reference adapter does not support suspend/resume");
  }

  async terminate(input: Parameters<ManagedSandboxPort["terminate"]>[0]): Promise<void> {
    await this.#remove(input.lease);
  }

  async reap(input: Parameters<ManagedSandboxPort["reap"]>[0]): Promise<void> {
    await this.#remove(input.lease);
  }

  async #remove(lease: ManagedSandboxLease): Promise<void> {
    this.#assertLease(lease);
    const result = await this.#docker.run(["rm", "--force", lease.runtimeId]);
    this.#known.delete(lease.runtimeId);
    if (result.exitCode !== 0 && !/no such container|not found/i.test(result.stderr)) {
      throw new Error(`docker rm failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
  }

  async inspect(lease: ManagedSandboxLease): Promise<SandboxObservation> {
    this.#assertLease(lease);
    const result = await this.#docker.run([
      "inspect",
      "--format",
      "{{.State.Status}}",
      lease.runtimeId,
    ]);
    if (result.exitCode !== 0) return { state: "stopped" };
    const state = result.stdout.trim();
    if (state === "running" || state === "created" || state === "restarting") {
      return { state: "running" };
    }
    if (state === "paused") return { state: "suspended" };
    if (state === "exited" || state === "dead" || state === "removing") {
      return { state: "stopped" };
    }
    return { state: "unknown" };
  }

  async run(
    input: Parameters<SandboxHarnessDriverPort["run"]>[0],
  ): Promise<{ type: "completed" } | { type: "aborted" }> {
    this.#assertLease(input.sandbox);
    const killOnAbort = () => {
      void this.#docker.run(["kill", input.sandbox.runtimeId]).catch(() => {});
    };
    input.signal.addEventListener("abort", killOnAbort, { once: true });
    try {
      const result = await this.#docker.run(
        ["start", "--attach", input.sandbox.runtimeId],
        { signal: input.signal },
      );
      if (input.signal.aborted) return { type: "aborted" };
      if (result.exitCode !== 0) {
        throw new Error(`docker start failed (${result.exitCode}): ${result.stderr.trim()}`);
      }
      return { type: "completed" };
    } finally {
      input.signal.removeEventListener("abort", killOnAbort);
    }
  }

  async open(
    input: Parameters<HarnessSupervisorTransportPort["open"]>[0],
  ): Promise<HarnessSupervisorChannel> {
    this.#assertLease(input.sandbox);
    input.signal.throwIfAborted();
    const spawnDuplex = this.#docker.spawnDuplex;
    if (spawnDuplex === undefined) {
      throw new Error("Docker command Port has no duplex process capability");
    }
    const process = spawnDuplex.call(this.#docker, [
      "start",
      "--attach",
      "--interactive",
      input.sandbox.runtimeId,
    ]);
    const writer = process.stdin.getWriter();
    const encoder = new TextEncoder();
    let eventsClaimed = false;
    let closed = false;
    void drainDockerStream(process.stderr).catch(() => {});
    const onAbort = () => {
      void process.kill("SIGTERM").catch(() => {});
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    return {
      async send(command: HarnessSupervisorCommand) {
        if (closed) throw new Error("Harness supervisor channel is closed");
        input.signal.throwIfAborted();
        await writer.write(encoder.encode(`${JSON.stringify(command)}\n`));
      },
      events(signal) {
        if (eventsClaimed) {
          throw new Error("Harness supervisor event stream can only be consumed once");
        }
        eventsClaimed = true;
        return dockerSupervisorEvents(process.stdout, signal);
      },
      async close() {
        if (closed) return;
        closed = true;
        input.signal.removeEventListener("abort", onAbort);
        await writer.close().catch(() => {});
        writer.releaseLock();
        await process.kill("SIGTERM").catch(() => {});
      },
    };
  }

  #assertLease(lease: ManagedSandboxLease): void {
    if (lease.provider !== "docker" || lease.runtimeId.length === 0) {
      throw new Error("Docker adapter received an incompatible sandbox lease");
    }
  }

  #mount(source: string, destination: string, readOnly = false): string {
    if (source.includes(",") || destination.includes(",")) {
      throw new Error("Docker bind mount paths cannot contain commas");
    }
    return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
  }
}

async function drainDockerStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // Drain diagnostics so a noisy supervisor cannot block on stderr.
    }
  } finally {
    reader.releaseLock();
  }
}

async function* dockerSupervisorEvents(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<HarnessSupervisorEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) yield parseDockerSupervisorEvent(line);
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.length > 0) yield parseDockerSupervisorEvent(trailing);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseDockerSupervisorEvent(line: string): HarnessSupervisorEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Harness supervisor emitted invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error("Harness supervisor event must be an object with a type");
  }
  const event = parsed as Record<string, unknown>;
  switch (event.type) {
    case "ready":
      if (event.protocol !== "openma-harness-supervisor-v1") {
        throw new Error("Harness supervisor emitted an unsupported ready protocol");
      }
      return { type: "ready", protocol: event.protocol };
    case "heartbeat":
      if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0) {
        throw new Error("Harness supervisor heartbeat sequence must be non-negative");
      }
      return { type: "heartbeat", sequence: Number(event.sequence) };
    case "completed":
      if (!Number.isSafeInteger(event.exitCode)) {
        throw new Error("Harness supervisor completion exitCode must be an integer");
      }
      return { type: "completed", exitCode: Number(event.exitCode) };
    case "drained":
      return { type: "drained" };
    case "error":
      if (typeof event.message !== "string" || event.message.length === 0) {
        throw new Error("Harness supervisor error message must be non-empty");
      }
      return { type: "error", message: event.message };
    default:
      throw new Error(`Unknown harness supervisor event: ${String(event.type)}`);
  }
}
