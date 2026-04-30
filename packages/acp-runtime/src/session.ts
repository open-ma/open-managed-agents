/**
 * AcpSession — owns one ACP child + its ClientSideConnection.
 *
 * Translates between the ACP SDK's request/response + notification model
 * and the higher-level AsyncIterable-of-events shape that callers want.
 *
 * SDK shape (from @agentclientprotocol/sdk):
 *   - `agent.prompt(req)` is request/response; resolves when the turn ends.
 *   - Streaming events (sessionUpdate, etc.) arrive on the *Client* callbacks
 *     we pass into ClientSideConnection.
 *
 * Our shape: `prompt(text)` returns AsyncIterable<unknown>. We collect
 * sessionUpdate notifications on a queue while `agent.prompt()` runs, then
 * end the iterator when prompt resolves. This is a thin transformation, not
 * a re-implementation — the SDK still owns JSON-RPC framing, request IDs,
 * cancellation propagation, etc.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  type Agent,
  type Client,
} from "@agentclientprotocol/sdk";
import type { AcpSession, ChildHandle, SessionOptions } from "./types.js";

interface ConstructDeps {
  /** Whatever the spawner produced — owned by this session, killed on dispose. */
  child: ChildHandle;
  /** Echoed from start() so callers can see how this session was configured. */
  options: SessionOptions;
  /** Stable id; AcpRuntime supplies one per start(). */
  id: string;
}

export class AcpSessionImpl implements AcpSession {
  readonly id: string;
  readonly options: SessionOptions;

  /** Public read-only view of the agent-issued sessionId. Empty until init() resolves. */
  get acpSessionId(): string {
    return this.#sessionId ?? "";
  }

  #child: ChildHandle;
  #agent!: Agent;                  // initialized in init()
  #sessionId!: string;              // ACP-side session id (different from this.id)
  #disposed = false;
  /**
   * Notifications from the agent that arrived while a prompt was in flight.
   * The Client handler we pass into ClientSideConnection pushes here; the
   * AsyncIterable returned by prompt() pulls.
   */
  #pendingEvents: unknown[] = [];
  #waiters: Array<(v: IteratorResult<unknown>) => void> = [];

  constructor(deps: ConstructDeps) {
    this.id = deps.id;
    this.options = deps.options;
    this.#child = deps.child;
  }

  /**
   * Initialize the SDK connection, run protocol handshake, and create an
   * ACP session. Must be awaited before prompt() is callable. Caller
   * (AcpRuntime.start) does this and only returns the session once init
   * completes successfully.
   */
  async init(): Promise<void> {
    const stream = ndJsonStream(this.#child.stdin, this.#child.stdout);

    // The Client we hand to the SDK is what receives notifications from the
    // agent (sessionUpdate, requestPermission, terminalCreate, etc.). We
    // implement only what the runtime needs to surface; everything else
    // is best-effort no-op so the SDK doesn't reject the message.
    const conn = new ClientSideConnection(
      (_agent: Agent): Client => ({
        sessionUpdate: async (params: unknown) => {
          this.#pushEvent(params);
        },
        // Permissions / terminals / file ops: surface as events too.
        // Higher layers (clash bridge, openma session) decide handling.
        requestPermission: async (params: unknown) => {
          this.#pushEvent({ type: "requestPermission", params });
          // Default policy: deny. Hosts can intercept by overriding.
          return { outcome: { type: "cancelled" as const } } as never;
        },
      } as unknown as Client),
      stream,
    );
    this.#agent = conn;

    const initResult = await this.#agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as never);

    // Try to resume an existing ACP session if asked. Agents that advertise
    // loadSession in agentCapabilities will respond; older / leaner agents
    // won't. We fall back to a fresh `session/new` instead of failing —
    // losing transcript history is preferable to crashing the chat.
    const wantsResume = this.options.resumeAcpSessionId;
    const supportsLoad = (initResult as { agentCapabilities?: { loadSession?: boolean } })
      ?.agentCapabilities?.loadSession === true;

    if (wantsResume && supportsLoad) {
      try {
        await (this.#agent as unknown as { loadSession?: (p: unknown) => Promise<unknown> }).loadSession?.({
          sessionId: wantsResume,
          cwd: this.options.agent.cwd ?? process.cwd(),
          mcpServers: this.options.mcpServers ?? [],
        });
        this.#sessionId = wantsResume;
        return;
      } catch (e) {
        // Resume failed (e.g. on-disk transcript was deleted) — fall
        // through to creating a fresh session.
        // eslint-disable-next-line no-console
        console.error(`[acp] session/load(${wantsResume}) failed, falling back to new:`, e);
      }
    }

    const newSession = await this.#agent.newSession({
      cwd: this.options.agent.cwd ?? process.cwd(),
      mcpServers: this.options.mcpServers ?? [],
    } as never);
    this.#sessionId = (newSession as { sessionId: string }).sessionId;
  }

  prompt(text: string, opts?: { abortSignal?: AbortSignal }): AsyncIterable<unknown> {
    if (this.#disposed) {
      throw new Error(`AcpSession ${this.id} is disposed`);
    }
    return this.#promptIter(text, opts);
  }

  async *#promptIter(text: string, opts?: { abortSignal?: AbortSignal }): AsyncIterable<unknown> {
    // Wire the abort signal through to ACP's cancel(). The SDK doesn't
    // do this for us — `prompt()` will hang until the agent finishes
    // unless we explicitly cancel.
    const onAbort = () => {
      this.#agent.cancel({ sessionId: this.#sessionId } as never).catch(() => { /* best effort */ });
    };
    opts?.abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Per-turn timeout. Compose with caller's signal so either cancels both.
    const turnAbort = new AbortController();
    const turnTimer = this.options.perTurnTimeoutMs
      ? setTimeout(() => turnAbort.abort(), this.options.perTurnTimeoutMs)
      : null;
    if (opts?.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => turnAbort.abort(), { once: true });
    }
    turnAbort.signal.addEventListener("abort", onAbort, { once: true });

    // Fire the prompt request; events will pile into #pendingEvents while
    // it's in flight. We yield them as they arrive, end when prompt resolves.
    const promptDone = this.#agent
      .prompt({
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text } as never],
      } as never)
      .finally(() => {
        if (turnTimer) clearTimeout(turnTimer);
        opts?.abortSignal?.removeEventListener("abort", onAbort);
      });

    // Sentinel: the prompt completion is itself the last event. We mark
    // the queue as ended via #endStream() once it resolves.
    let ended = false;
    const endPromise = promptDone.then(
      (response) => {
        ended = true;
        this.#pushEvent({ type: "promptComplete", response });
        this.#endStream();
      },
      (err) => {
        ended = true;
        this.#pushEvent({ type: "promptError", error: String(err) });
        this.#endStream();
      },
    );

    while (true) {
      if (this.#pendingEvents.length > 0) {
        const ev = this.#pendingEvents.shift();
        yield ev;
        continue;
      }
      if (ended) break;
      // Wait for either next event or stream-end.
      await new Promise<void>((resolve) => {
        this.#waiters.push(() => resolve());
      });
    }

    // Make sure we surface any error from the prompt promise itself.
    await endPromise;
  }

  async provideToolResult(toolCallId: string, result: unknown): Promise<void> {
    // ACP's tool flow goes through the Client side — the agent issues
    // requestPermission / terminal calls / etc. and we respond. Tool
    // *execution* results flow back through whatever mechanism the
    // agent invented; ACP doesn't have a single "tool result" RPC.
    // For now this is a stub — wire concrete behaviour when openma
    // (the only caller that needs it) lands its tool integration.
    void toolCallId;
    void result;
    throw new Error("provideToolResult not yet implemented — see ACP tool/permission flow");
  }

  isAlive(): boolean {
    return !this.#disposed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#endStream();
    await this.#child.kill("SIGTERM").catch(() => { /* already gone */ });
  }

  /** Producer side of the event queue; called from Client callbacks. */
  #pushEvent(ev: unknown): void {
    this.#pendingEvents.push(ev);
    const w = this.#waiters.shift();
    w?.({ value: undefined, done: false });
  }

  /** Wakes up all waiters so the iterator can observe `ended === true`. */
  #endStream(): void {
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ value: undefined, done: true });
    }
  }
}
