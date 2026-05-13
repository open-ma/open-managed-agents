// SessionRouter — uniform contract over the per-runtime session routing
// layer. Lets `@open-managed-agents/http-routes` mount /v1/sessions/*
// once and dispatch to either the CF SessionDO (apps/main) or the Node
// SessionRegistry (apps/main-node) without the routes touching env
// bindings or sandbox internals.
//
// Method shapes mirror the SessionDO RPC surface in
// apps/agent/src/runtime/session-do.ts:
//   PUT  /init                                → init()
//   DELETE /destroy                           → destroy()
//   POST /event                               → appendEvent()
//   GET  /events                              → getEvents()
//   GET  /full-status                         → getFullStatus()
//   POST /exec                                → exec()
//   POST /__debug_recovery__                  → triggerDebugRecovery()
//   GET  /file?path=...                       → readSandboxFile()
//   GET  /threads                             → listThreads()
//   GET  /threads/:tid                        → getThread()
//   POST /threads/:tid/archive                → archiveThread()
//   GET  /threads/:tid/events                 → getThreadEvents()
//   GET  /ws (WebSocket bridge)               → streamEvents() (SSE-shaped)

import type {
  ContentBlock,
  CredentialConfig,
  SessionEvent,
  SessionRecord,
  StoredEvent,
  AgentConfig,
  EnvironmentConfig,
} from "@open-managed-agents/shared";

export interface SessionInitParams {
  agentId: string;
  environmentId: string;
  title: string;
  tenantId: string;
  vaultIds?: string[];
  agentSnapshot?: AgentConfig;
  environmentSnapshot?: EnvironmentConfig;
  vaultCredentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  initEvents?: SessionEvent[];
}

export interface SessionEventsQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
  threadId?: string;
}

export interface SessionEventsPage {
  data: StoredEvent[];
  has_more: boolean;
}

export interface SessionFullStatus {
  status: string;
  usage: { input_tokens: number; output_tokens: number };
  outcome_evaluations?: Array<{
    outcome_id?: string;
    result: string;
    iteration: number;
    explanation?: string;
    feedback?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    processed_at?: string;
  }>;
  resources?: unknown[];
}

export interface SessionExecResult {
  exit_code: number;
  output: string;
  truncated: boolean;
}

export interface SessionAppendResult {
  /** Status returned by the underlying runtime's POST /event handler.
   *  202 on accept, 4xx/409 when the session is terminated. */
  status: number;
  /** JSON envelope to surface to the caller. Routes pass it through
   *  verbatim so the AMA wire shape (request_id, error.type) is
   *  preserved. */
  body: string;
}

export interface SessionStreamFrame {
  /** Raw event JSON. Bridge already validates it's well-formed. */
  data: string;
  /** When the event carries a session_thread_id, used by route filter. */
  threadId?: string;
}

/**
 * Read-only stream subscription. CF impls back this with the SessionDO
 * /ws WebSocket bridge; Node impls fan out from EventStreamHub.
 */
export interface SessionStreamHandle {
  /** Async iterator of frames. Iteration ends when the runtime closes
   *  the stream (session destroyed, hibernated, etc.). */
  [Symbol.asyncIterator](): AsyncIterator<SessionStreamFrame>;
  /** Caller-driven cancel — stops the underlying socket / subscription. */
  close(): void;
}

export interface SessionRouter {
  /** Initialize / warm the session. CF: PUT /init on the SessionDO.
   *  Node: warm the SessionRegistry entry + persist init events. */
  init(sessionId: string, params: SessionInitParams): Promise<void>;

  /** Tear down sandbox + emit final usage. CF: DELETE /destroy. Node:
   *  sandbox.destroy + clear registry entry. */
  destroy(sessionId: string): Promise<void>;

  /** Submit a user.* event. Returns the underlying status + body so
   *  routes can pass non-202 (terminated 409) verbatim. */
  appendEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<SessionAppendResult>;

  /** Paginated event read. */
  getEvents(
    sessionId: string,
    opts?: SessionEventsQuery,
  ): Promise<SessionEventsPage>;

  /** Open a live event stream. Caller drives consumption + close. */
  streamEvents(
    sessionId: string,
    opts?: { threadId?: string; lastEventId?: number },
  ): Promise<SessionStreamHandle>;

  /** Abort the in-flight harness for the session. No-op when nothing's
   *  running. CF: DO POST /event with user.interrupt. Node:
   *  SessionRegistry.interrupt(). */
  interrupt(sessionId: string, reason?: string): Promise<void>;

  /** Run a raw shell command in the session's sandbox (eval / verifier
   *  helper). */
  exec(
    sessionId: string,
    body: { command: string; timeout_ms?: number },
  ): Promise<SessionExecResult>;

  /** Read the live full-status (usage, outcome_evaluations, resources)
   *  for GET /v1/sessions/:id overlay. Returns null when the runtime is
   *  unreachable; route falls back to the stored row. */
  getFullStatus(sessionId: string): Promise<SessionFullStatus | null>;

  /** Read a file out of the sandbox by path — used to promote sandbox
   *  paths to first-class file_ids. CF: DO GET /file?path=. Node: read
   *  from sandbox workdir. */
  readSandboxFile(sessionId: string, path: string): Promise<ArrayBuffer | null>;

  /** Token-gated debug recovery probe. */
  triggerDebugRecovery(
    sessionId: string,
    token: string,
  ): Promise<{ status: number; body: string }>;

  /** Build the Trajectory v1 envelope for /v1/sessions/:id/trajectory. */
  getTrajectory(
    session: SessionRecord,
    helpers: {
      fetchEnvironmentConfig: () => Promise<EnvironmentConfig | null>;
    },
  ): Promise<unknown>;

  // ── Threads ───────────────────────────────────────────────────────────
  listThreads(sessionId: string): Promise<unknown>;
  getThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }>;
  getThreadEvents(
    sessionId: string,
    threadId: string,
    opts?: SessionEventsQuery,
  ): Promise<SessionEventsPage>;
  archiveThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }>;
}

/** Thin helper: converts a base64-encoded ContentBlock (image / document)
 *  back to its `{file_id}` source by uploading bytes to the runtime's
 *  storage. Currently unused — placeholder for the parallel route that
 *  promotes inline data into a re-referenceable file_id. */
export type FileIdResolver = (input: {
  tenantId: string;
  blocks: ContentBlock[];
}) => Promise<{ blocks: ContentBlock[]; mountFileIds: string[] }>;
