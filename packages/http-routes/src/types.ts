// Bundle of services + integration points handed to every mount factory.
// Each runtime (CF / Node) constructs its own bundle and passes it in.
// New routes get all of these via `services` — no implicit env / fetch
// access leaks into route code.
//
// `services` accepts either a fixed `RouteServices` (Node — services bundle
// is built once at process start) or a `(c) => RouteServices` callback
// (CF — services are per-request because of multi-tenant DB resolution).

import type { Context } from "hono";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { VaultService } from "@open-managed-agents/vaults-store";
import type { CredentialService } from "@open-managed-agents/credentials-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { KvStore } from "@open-managed-agents/kv-store";
import type {
  Logger,
  MetricsRecorder,
  Tracer,
} from "@open-managed-agents/observability";
import type { BrowserHarness } from "@open-managed-agents/browser-harness";

export interface BackgroundRunner {
  /** Fire-and-forget on Node (with logged error handler), waitUntil on CF. */
  run(p: Promise<unknown>): void;
}

/** Per-session event log + SSE fanout — handed to session routes so they
 *  can append + publish without knowing the backend. CF wraps the DO's
 *  storage; Node wraps SqlEventLog + InProcess/PgEventStreamHub. */
export interface EventStreamHub {
  publish(sessionId: string, event: unknown): void;
  /** Subscribe to live events for sessionId. Return an unsubscribe. The
   *  writer is invoked once per event in seq order. The `closed` flag
   *  is set by the hub to mark dropped writers; SSE handlers should
   *  set it themselves on transport error so the next publish skips. */
  attach(
    sessionId: string,
    writer: { closed: boolean; write(ev: unknown): void; close(): void },
  ): () => void;
}

export interface SessionRegistryLike {
  /** Route an inbound user.message to the harness for this session. */
  enqueueUserMessage?(sessionId: string, tenantId: string, agentId: string, ev: unknown): void;
  /** Trigger user.interrupt — abort the in-flight harness AbortController. */
  interrupt?(sessionId: string): void;
}

/**
 * Subset of services HTTP routes care about. Runtime-agnostic intentionally —
 * no D1Database / KVNamespace / R2Bucket leaks here. Optional fields use
 * `null` rather than absent so `if (services.x)` always works.
 */
export interface RouteServices {
  sql: SqlClient;
  agents: AgentService;
  vaults: VaultService;
  credentials: CredentialService;
  memory: MemoryStoreService;
  sessions: SessionService;
  kv: KvStore;
  /** Per-session event log writer. Bound to a sessionId at the call site. */
  newEventLog: (sessionId: string) => {
    appendAsync(ev: unknown): Promise<void>;
    getEventsAsync(afterSeq?: number): Promise<unknown[]>;
  };
  hub: EventStreamHub;
  sessionRegistry?: SessionRegistryLike;
  background: BackgroundRunner;
  /** Outputs root for /v1/sessions/:id/outputs[/:filename]. Null disables
   *  the routes (CF returns from R2 via blobStore instead — wire it via
   *  outputsBlob). */
  outputsRoot?: string | null;
  // ── Observability — appended (P6). New fields go AT THE END so a
  // parallel branch adding `browser` (P7) merges without conflict. ──
  /** Structured logger. Routes pull `services.logger.child({...})` to
   *  get a per-request handle; bootstrap-time top-level logger is fine
   *  for handlers that don't need extra binding. Optional so legacy
   *  test fixtures that build an ad-hoc RouteServices still compile. */
  logger?: Logger;
  /** Counter / histogram / gauge / event recorder. Optional for the
   *  same reason — middleware/route code falls back to a noop when
   *  unset. */
  metrics?: MetricsRecorder;
  /** OTel-flavored span source. Optional; CF wires a noop, Node wires
   *  the real OTel SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  tracer?: Tracer;
  // ── Browser tool — appended (P7). Strictly additive: when null/absent,
  // browser tools are unavailable and agents fall back to web_fetch. ──
  /** Browser-tool factory. CF wires the @cloudflare/playwright adapter,
   *  Node self-host wires playwright-core, CDP-connect, or the
   *  throw-on-call Disabled adapter depending on env. Null when no
   *  backend is configured (legacy fixtures); the harness silently
   *  skips browser tool registration. */
  browser?: BrowserHarness | null;
}

/** Per-request services accessor. CF passes a callback that resolves
 *  RouteServices off `c.var.services` + `c.var.tenantDb`; Node passes a
 *  static bundle that the helper turns into a no-arg thunk. Use
 *  `resolveServices` in handlers, never read `deps.services` directly. */
export type RouteServicesArg = RouteServices | ((c: Context) => RouteServices);

export function resolveServices(
  arg: RouteServicesArg,
  c: Context,
): RouteServices {
  return typeof arg === "function" ? arg(c) : arg;
}
