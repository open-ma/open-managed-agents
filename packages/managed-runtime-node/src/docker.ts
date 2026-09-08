import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  SessionInputMaterializerPort,
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
      let aborted = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        cleanup();
        reject(aborted ? options.signal?.reason : error);
      });
      child.once("close", (code) => {
        cleanup();
        if (aborted) {
          reject(options.signal?.reason);
          return;
        }
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
  implements ManagedSandboxPort, SandboxHarnessDriverPort, HarnessSupervisorTransportPort,
    SessionInputMaterializerPort
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
    const containerName = `oma-${sha256(
      `${input.scope.workId}:${input.fence.generation}`,
    ).slice(0, 24)}`;
    const workspace = this.#mount(
      safeMetadataPath(input.workspace.metadata?.hostPath, "workspace binding"),
      input.workspace.mountPath,
    );
    const args = [
      "create",
      "--name",
      containerName,
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
    if (process.cwd !== undefined) args.push("--workdir", process.cwd);
    for (const [name, value] of Object.entries(process.env ?? {})) {
      args.push("--env", `${name}=${value}`);
    }
    // Keep allocation separate from execution: Session inputs and credential
    // egress are attached after acquire and before the worker starts.
    args.push("--entrypoint", "/bin/sh");
    args.push(this.#options.image, "-c", "while :; do sleep 3600; done");
    let result: DockerCommandResult;
    try {
      // `docker create` is a commit operation in the daemon. Killing the CLI
      // when the fence signal aborts can race the daemon: an early `rm` sees no
      // container, then the detached daemon request commits an orphan. Treat
      // create as a short non-cancellable commit barrier, then honor the abort
      // only after its deterministic cleanup handle is known.
      result = await this.#docker.run(args);
    } catch (error) {
      await this.#docker.run(["rm", "--force", containerName]).catch(() => undefined);
      throw error;
    }
    if (input.signal.aborted) {
      const committedId = result.stdout.trim();
      await this.#docker.run([
        "rm",
        "--force",
        committedId === "" ? containerName : committedId,
      ]).catch(() => undefined);
      input.signal.throwIfAborted();
    }
    if (result.exitCode !== 0) {
      // docker create can commit the daemon-side container immediately before
      // the local CLI is interrupted. Its deterministic generation-scoped
      // name is the only reliable cleanup handle when stdout never arrives.
      await this.#docker.run(["rm", "--force", containerName]).catch(() => undefined);
      throw new Error(`docker create failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    const runtimeId = result.stdout.trim();
    if (runtimeId.length === 0) {
      await this.#docker.run(["rm", "--force", containerName]).catch(() => undefined);
      throw new Error("docker create returned no container id");
    }
    this.#known.add(runtimeId);
    let started: DockerCommandResult;
    try {
      started = await this.#docker.run(["start", runtimeId], {
        signal: input.signal,
      });
    } catch (error) {
      await this.#docker.run(["rm", "--force", runtimeId]).catch(() => undefined);
      this.#known.delete(runtimeId);
      throw error;
    }
    if (started.exitCode !== 0) {
      await this.#docker.run(["rm", "--force", runtimeId]).catch(() => undefined);
      this.#known.delete(runtimeId);
      throw new Error(
        `docker start failed (${started.exitCode}): ${started.stderr.trim()}`,
      );
    }
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

  async materialize(
    input: Parameters<SessionInputMaterializerPort["materialize"]>[0],
  ): Promise<void> {
    this.#assertLease(input.sandbox);
    for (const resource of input.session.resources) {
      input.signal.throwIfAborted();
      if (resource.type === "memory_store") {
        if (input.resourceOwnership.memoryStore === "worker") continue;
        throw new Error(
          "Docker generic Session input materializer does not implement memory_store synchronization",
        );
      }
      if (resource.type === "file") {
        if (input.access === undefined) {
          throw new Error(
            "Session file materialization requires per-claim SessionInputAccessPort",
          );
        }
        const fileId = requiredResourceString(resource, "file_id");
        const mountPath = safeResourceMountPath(resource);
        const file = await input.access.downloadFile({
          fileId,
          signal: input.signal,
        });
        input.signal.throwIfAborted();
        await this.#runChecked(
          ["exec", input.sandbox.runtimeId, "mkdir", "-p", dirname(mountPath)],
          input.signal,
          "create Session file parent",
        );
        const stage = await mkdtemp(join(tmpdir(), "oma-session-input-"));
        const source = join(stage, "payload");
        try {
          await writeFile(source, file.content);
          await this.#runChecked(
            ["cp", source, `${input.sandbox.runtimeId}:${mountPath}`],
            input.signal,
            "copy Session file",
          );
        } finally {
          await rm(stage, { force: true, recursive: true });
        }
        continue;
      }
      if (resource.type === "github_repository") {
        if (input.activeWorkspaceCheckpoint !== null) continue;
        const url = safeRepositoryUrl(resource);
        const mountPath = safeResourceMountPath(resource);
        const rawCheckout = resource.checkout;
        const checkout = typeof rawCheckout === "object" && rawCheckout !== null
          ? rawCheckout as Readonly<Record<string, unknown>>
          : null;
        const branch = checkout?.type === "branch"
          && typeof checkout.name === "string"
          && checkout.name.length > 0
          ? checkout.name
          : null;
        await this.#runChecked(
          [
            "exec",
            "--env",
            "GIT_TERMINAL_PROMPT=0",
            input.sandbox.runtimeId,
            "git",
            "clone",
            ...(branch === null ? [] : ["--branch", branch]),
            "--",
            url,
            mountPath,
          ],
          input.signal,
          "clone Session repository",
        );
        if (checkout?.type === "commit") {
          const sha = typeof checkout.sha === "string" ? checkout.sha : "";
          if (!/^[0-9a-f]{7,64}$/iu.test(sha)) {
            throw new Error("Session github_repository commit checkout is invalid");
          }
          await this.#runChecked(
            [
              "exec",
              input.sandbox.runtimeId,
              "git",
              "-C",
              mountPath,
              "checkout",
              "--detach",
              sha,
            ],
            input.signal,
            "checkout Session repository commit",
          );
        }
        continue;
      }
      throw new Error(`Unsupported Session resource type: ${resource.type}`);
    }
  }

  async run(
    input: Parameters<SandboxHarnessDriverPort["run"]>[0],
  ): Promise<{ type: "completed" } | { type: "aborted" }> {
    this.#assertLease(input.sandbox);
    if (input.signal.aborted) return { type: "aborted" };
    const killOnAbort = () => {
      void this.#docker.run(["kill", input.sandbox.runtimeId]).catch(() => {});
    };
    input.signal.addEventListener("abort", killOnAbort, { once: true });
    try {
      if (input.driver.type !== "ama_worker") {
        throw new Error(`Docker direct driver cannot run ${input.driver.type}`);
      }
      const process = input.driver.process;
      let result: DockerCommandResult;
      try {
        result = await this.#docker.run(
          [
            "exec",
            input.sandbox.runtimeId,
            process.command,
            ...(process.args ?? []),
          ],
          { signal: input.signal },
        );
      } catch (error) {
        if (input.signal.aborted) return { type: "aborted" };
        throw error;
      }
      if (input.signal.aborted) return { type: "aborted" };
      if (result.exitCode !== 0) {
        throw new Error(`docker exec failed (${result.exitCode}): ${result.stderr.trim()}`);
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
      "exec",
      "--interactive",
      input.sandbox.runtimeId,
      input.process.command,
      ...(input.process.args ?? []),
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

  async #runChecked(
    args: readonly string[],
    signal: AbortSignal,
    operation: string,
  ): Promise<void> {
    const result = await this.#docker.run(args, { signal });
    if (result.exitCode !== 0) {
      throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
  }

  #mount(source: string, destination: string, readOnly = false): string {
    if (source.includes(",") || destination.includes(",")) {
      throw new Error("Docker bind mount paths cannot contain commas");
    }
    return `type=bind,src=${source},dst=${destination}${readOnly ? ",readonly" : ""}`;
  }
}

function requiredResourceString(
  resource: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = resource[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Session ${resource.type} resource requires ${field}`);
  }
  return value;
}

function safeResourceMountPath(resource: Readonly<Record<string, unknown>>): string {
  const path = requiredResourceString(resource, "mount_path");
  if (!path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) {
    throw new Error("Session resource mount_path must be absolute and may not traverse parents");
  }
  return path;
}

function safeRepositoryUrl(resource: Readonly<Record<string, unknown>>): string {
  const value = requiredResourceString(resource, "url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Session github_repository resource has an invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Session github_repository URL must use HTTP(S)");
  }
  return value;
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
      // A cancelled Web reader resolves a pending read as done; re-check the
      // claim signal so lease loss is not misreported as graceful EOF.
      signal.throwIfAborted();
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
    case "checkpoint":
      if (
        typeof event.checkpointId !== "string" || event.checkpointId.length === 0
        || typeof event.sessionId !== "string" || event.sessionId.length === 0
        || (event.turnId !== undefined
          && (typeof event.turnId !== "string" || event.turnId.length === 0))
      ) {
        throw new Error("Harness supervisor checkpoint request is invalid");
      }
      return {
        type: "checkpoint",
        checkpointId: event.checkpointId,
        sessionId: event.sessionId,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      };
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
