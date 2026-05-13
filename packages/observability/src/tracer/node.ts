// Node tracer — wraps @opentelemetry/api. The SDK boots only when
// OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise startSpan / startActiveSpan
// resolve to no-ops via the OTel API's default implementation.
//
// Auto-instrumentation: when OTEL_AUTO_INSTRUMENTATIONS=1 we wire
// `@opentelemetry/auto-instrumentations-node`, which patches `http`, `pg`,
// `better-sqlite3`, etc. via OTel-style monkey-patching. Off by default
// because the patch surface is broad and load-bearing for some providers
// (e.g. AI SDK).
//
// Distributed propagation across the agent worker / sandbox subprocess is
// NOT done here — the agent runs in CF where the tracer is a noop. Adding
// it would require either a trace-id passthrough header on the few RPC
// boundaries we cross, or wiring OTel-on-workerd. Deferred.

import type {
  Tracer as ObsTracer,
  Span,
  SpanAttributes,
  SpanOptions,
} from "../types";
import { NoopTracer } from "../root";

export interface NodeTracerOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** OTLP endpoint. Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env. When
   *  unset the tracer is a no-op. */
  otlpEndpoint?: string;
  /** Whether to enable @opentelemetry/auto-instrumentations-node.
   *  Defaults to OTEL_AUTO_INSTRUMENTATIONS=1. */
  autoInstrumentations?: boolean;
}

export type NodeTracerHandle = ObsTracer & {
  /** Flush + shutdown. main-node calls during graceful shutdown so the last
   *  spans don't get dropped. */
  shutdown(): Promise<void>;
};

export async function createNodeTracer(
  opts: NodeTracerOptions = {},
): Promise<NodeTracerHandle> {
  const endpoint = opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    const noop = new NoopTracer();
    return Object.assign(noop, { async shutdown() {} });
  }

  // Lazy imports — keep CF / non-OTel users free of the heavy SDK surface.
  const sdkMod = await import("@opentelemetry/sdk-node").catch(() => null);
  const apiMod = await import("@opentelemetry/api").catch(() => null);
  const traceExpMod = await import(
    "@opentelemetry/exporter-trace-otlp-http"
  ).catch(() => null);
  const resourceMod = await import("@opentelemetry/resources").catch(() => null);
  const semconvMod = await import("@opentelemetry/semantic-conventions").catch(() => null);

  if (!sdkMod || !apiMod || !traceExpMod) {
    // Peer dep missing — silently fall back to noop. main-node bootstrap
    // already logs a warning before calling us.
    const noop = new NoopTracer();
    return Object.assign(noop, { async shutdown() {} });
  }

  const NodeSDK = sdkMod.NodeSDK;
  const OTLPTraceExporter = traceExpMod.OTLPTraceExporter;
  const Resource = resourceMod
    ? (resourceMod as { Resource?: typeof import("@opentelemetry/resources").Resource }).Resource
    : undefined;
  const semconv = semconvMod as
    | typeof import("@opentelemetry/semantic-conventions")
    | null;

  const resource = Resource && semconv
    ? new Resource({
        [semconv.SemanticResourceAttributes?.SERVICE_NAME ?? "service.name"]:
          opts.serviceName ?? "oma-main-node",
        [semconv.SemanticResourceAttributes?.SERVICE_VERSION ?? "service.version"]:
          opts.serviceVersion ?? "0.1.0",
      })
    : undefined;

  // OTel auto-instrumentations are lazy-imported; the precise type isn't in
  // scope without forcing a hard dep, so use any for the SDK option shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instrumentations: any[] = [];
  const autoOn = opts.autoInstrumentations ?? process.env.OTEL_AUTO_INSTRUMENTATIONS === "1";
  if (autoOn) {
    const autoMod = await import("@opentelemetry/auto-instrumentations-node").catch(
      () => null,
    );
    if (autoMod) instrumentations = [autoMod.getNodeAutoInstrumentations()];
  }

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations,
    ...(resource ? { resource } : {}),
  });
  sdk.start();

  const tracer = apiMod.trace.getTracer(opts.serviceName ?? "oma-main-node");

  return {
    startSpan(name: string, options?: SpanOptions): Span {
      const s = tracer.startSpan(name, { attributes: cleanAttrs(options?.attributes) });
      return wrap(s);
    },
    startActiveSpan<T>(
      name: string,
      fn: (span: Span) => T | Promise<T>,
      options?: SpanOptions,
    ): T | Promise<T> {
      return tracer.startActiveSpan(name, { attributes: cleanAttrs(options?.attributes) }, (s) => {
        const wrapped = wrap(s);
        try {
          const result = fn(wrapped);
          if (result instanceof Promise) {
            return result.finally(() => wrapped.end()) as T | Promise<T>;
          }
          wrapped.end();
          return result;
        } catch (err) {
          wrapped.recordException(err);
          wrapped.setStatus({ code: 2 });
          wrapped.end();
          throw err;
        }
      });
    },
    async shutdown() {
      await sdk.shutdown().catch(() => {});
    },
  };
}

function cleanAttrs(attrs?: SpanAttributes): Record<string, string | number | boolean> | undefined {
  if (!attrs) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function wrap(s: import("@opentelemetry/api").Span): Span {
  return {
    setAttribute(k, v) { s.setAttribute(k, v); },
    setAttributes(a) {
      const cleaned = cleanAttrs(a);
      if (cleaned) s.setAttributes(cleaned);
    },
    recordException(e) { s.recordException(e instanceof Error ? e : new Error(String(e))); },
    setStatus(st) { s.setStatus(st); },
    end() { s.end(); },
  };
}
