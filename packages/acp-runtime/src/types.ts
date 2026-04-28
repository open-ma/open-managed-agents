/**
 * Core interfaces for spawning and driving an ACP-compatible agent.
 *
 * Three layers, intentionally separated so the same agent-driving code
 * (`AcpRuntime`) works whether the agent is a local subprocess (clash-bridge
 * use case) or running inside an openma sandbox container (openma session
 * use case).
 *
 *   [Spawner]            How a child process gets started + its stdio.
 *                        Different per host: Node child_process for local,
 *                        openma sandbox.exec for cloud.
 *
 *   [ChildHandle]        The opaque process — read stdout, write stdin,
 *                        wait for exit, kill. AcpRuntime never inspects
 *                        process identity, just speaks JSON-RPC over the
 *                        streams.
 *
 *   [AcpRuntime]         Wraps a ChildHandle in @agentclientprotocol/sdk's
 *                        ClientSideConnection. Owns the conversation:
 *                        new session → prompt → stream events → close.
 *
 * The split also keeps the SDK dependency out of the spawner contracts —
 * a host can ship a Spawner without pulling in the ACP protocol layer.
 */

/**
 * Where to find the agent binary and how to invoke it.
 *
 * Stays minimal on purpose: registries / lifecycle / pairing all live above
 * this. A spawner only needs to know "run this command with these args/env".
 */
export interface AgentSpec {
  /** Executable name or absolute path. The spawner is responsible for $PATH lookup. */
  command: string;
  args?: string[];
  /** Process env. Inherits the spawner's env; spec entries override. An entry
   *  with `undefined` value EXPLICITLY UNSETS the inherited key — useful for
   *  scrubbing variables like `CLAUDECODE` that mark the parent as already
   *  inside a Claude Code session and would make a nested ACP child refuse
   *  to start. */
  env?: Record<string, string | undefined>;
  /** Working directory. Defaults to the spawner's cwd if omitted. */
  cwd?: string;
}

/**
 * Live process handle. AcpRuntime treats it as a duplex byte pipe + a
 * lifecycle. Spawners construct these; nothing else implements the type.
 */
export interface ChildHandle {
  /** Bytes the child reads from its stdin (i.e. JSON-RPC requests we send). */
  stdin: WritableStream<Uint8Array>;
  /** Bytes the child writes to its stdout (i.e. JSON-RPC responses + notifications). */
  stdout: ReadableStream<Uint8Array>;
  /**
   * Bytes the child writes to its stderr. Diagnostic only — never used as
   * protocol. Some hosts (cf-sandbox) may merge stderr into a log stream
   * instead of exposing it; in that case this returns an empty stream.
   */
  stderr: ReadableStream<Uint8Array>;
  /**
   * Best-effort termination. Returns when the child has actually exited or
   * the host has given up trying to wait (timeout configured by host).
   * Calling kill() on an already-exited child is a no-op.
   */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Resolves when the child exits. Never rejects — exit codes are values, not errors. */
  exited: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * A host implementation that knows how to launch processes for its environment.
 *
 * Host examples:
 *   - Node spawner (clash-bridge, local CLIs, dev tools)
 *   - CF sandbox spawner (openma session DO → its sandbox container)
 *   - Tauri/Electron spawner (BYO desktop client)
 *
 * All spawners must produce a fully-working ChildHandle BEFORE returning.
 * "Process is starting up but not ready yet" is the spawner's problem to
 * resolve, not the caller's — async stdio is hard to retrofit without
 * losing initial bytes.
 */
export interface Spawner {
  spawn(spec: AgentSpec): Promise<ChildHandle>;
}

/**
 * Restart behaviour for a single AcpSession's underlying child.
 *
 *   "never"            child crash kills the session. Caller decides what
 *                      to do (e.g. surface to user, persist failure).
 *   "on-crash"         restart automatically up to `maxRestarts` within
 *                      `windowMs`. Beyond that, give up and surface error.
 *   "always"           restart unconditionally. Only sensible for very
 *                      short-lived sessions or testing.
 *
 * Sessions store enough state (last prompt, transcript) to make restart
 * meaningful — but ACP itself has no replay primitive, so a restart on a
 * session mid-tool-call will probably leave the model confused. The
 * default is "never" for that reason; opt in carefully.
 */
export interface RestartPolicy {
  mode: "never" | "on-crash" | "always";
  maxRestarts?: number;
  windowMs?: number;
}

/**
 * High-level options when starting an AcpSession. Everything except
 * `agent` has reasonable defaults — wire only what differs from default.
 */
export interface SessionOptions {
  /** Spec the spawner will instantiate. */
  agent: AgentSpec;
  /** Defaults to `{ mode: "never" }`. */
  restart?: RestartPolicy;
  /**
   * If the session sees no inbound prompts for this long, the runtime
   * kills the child. 0 disables. Default: 30 minutes.
   */
  idleTimeoutMs?: number;
  /**
   * Hard cap on a single prompt/turn. The runtime aborts the in-flight
   * ACP request and surfaces a timeout error if exceeded. Default: 10 min.
   */
  perTurnTimeoutMs?: number;
  /**
   * If set, init() calls ACP `session/load` with this id instead of
   * `session/new`. Powers cross-process resume — the agent re-hydrates
   * a previous conversation from its on-disk transcript.
   *
   * Agents that don't support `session/load` (capability check at init
   * fails) fall back to a fresh `session/new` and the caller is expected
   * to surface the loss of history.
   */
  resumeAcpSessionId?: string;
}

/**
 * One configured-and-spawned ACP agent, hiding the JSON-RPC plumbing
 * behind an async-iterable event stream. Owns the ChildHandle and the
 * @agentclientprotocol/sdk ClientSideConnection.
 *
 * Caller must `dispose()` to kill the child + release stdio. Letting an
 * AcpSession get GC'd without dispose leaks the process.
 */
export interface AcpSession {
  /** Stable identifier for logging / pairing / multiplex routing. */
  readonly id: string;
  /** The ACP-side session id (returned by `session/new` or echoed by `session/load`). */
  readonly acpSessionId: string;
  /** Read-only snapshot of how this session was started. */
  readonly options: SessionOptions;

  /**
   * Send one user prompt and stream back ACP events until the agent
   * yields the turn (typically `session/turn-complete`). Each yielded
   * value is a raw ACP notification — caller is expected to handle the
   * protocol. For typed handlers, layer on top.
   */
  prompt(text: string, opts?: { abortSignal?: AbortSignal }): AsyncIterable<unknown>;

  /**
   * Apply a tool result that was requested by the agent. Use when the
   * agent issued `tools/request` and the host (= clash CLI, openma
   * sandbox, etc.) executed it out-of-band.
   */
  provideToolResult(toolCallId: string, result: unknown): Promise<void>;

  /** Whether the underlying child is still running. */
  isAlive(): boolean;

  /** Kill the child, close streams, release resources. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Factory that turns a Spawner into a session-creating runtime. The whole
 * "ACP agent management" surface narrows to this object — nothing else
 * needs to hold the spawner reference.
 */
export interface AcpRuntime {
  start(options: SessionOptions): Promise<AcpSession>;
}
