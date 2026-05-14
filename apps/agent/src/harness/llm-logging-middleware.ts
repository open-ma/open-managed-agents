// LLM full body logging middleware. Wraps every LanguageModel call
// (streamText / generateText) so we can persist the request +
// response to R2 for post-hoc debugging — "what did the model
// actually see / produce on this turn?"
//
// Storage: t/{tenant_id}/sessions/{session_id}/llm/{event_id}.json
// where event_id is the `id` on the matching span.model_request_end
// event (and span.model_request_start). Same id, computable from
// session_id + event_id at read time.
//
// Hook: AI SDK's wrapLanguageModel + LanguageModelMiddleware.
// wrapStream tees the stream so the harness still receives every
// chunk live; we accumulate a copy in memory and PUT to R2 on
// flush. wrapGenerate does the analogous thing for non-streaming
// calls.
//
// Failure mode: any R2 / serialization error is logged + swallowed.
// The model call's success path is independent of LLM logging — a
// dead R2 must not break the agent.

import type { LanguageModelMiddleware } from "ai";

export interface LlmLoggingContext {
  tenant_id: string;
  session_id: string;
  /** R2 bucket (typically env.FILES_BUCKET). When null/undefined the
   *  middleware is a no-op pass-through — useful for tests + when the
   *  binding is missing. */
  r2: R2Bucket | null | undefined;
  /** Lazy resolver for the span event id this call is paired with.
   *  default-loop mints the id in `experimental_onStepStart` BEFORE the
   *  provider call fires; the middleware reads via this closure so the
   *  per-step id is captured even though the middleware has been
   *  bound to the model once at the streamText() callsite. */
  spanIdResolver: () => string | null;
}

/** Headers stripped from the persisted request — never put credentials
 *  in R2 even though the bucket is private and tenant-scoped. */
const REDACT_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-api-key",
  "openai-api-key",
  "x-anthropic-api-key",
]);

function redactHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

function redactParams(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const p = params as Record<string, unknown>;
  // The AI SDK's V3 call options carry `headers` (provider-level) and
  // sometimes provider-specific options that may include API keys.
  // Shallow-copy and redact the headers field; leave the rest verbatim.
  return {
    ...p,
    headers: redactHeaders(p.headers),
  };
}

export function llmLoggingMiddleware(
  ctx: LlmLoggingContext,
): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream, params, model }) => {
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      const r2 = ctx.r2;
      const eventId = ctx.spanIdResolver();
      // Defer the underlying provider call. If it throws (provider
      // error / network), the catch below records the failure and
      // re-throws so the harness sees the same exception path.
      let result;
      try {
        result = await doStream();
      } catch (err) {
        // Best-effort error log — model calls that fail before
        // returning a stream still produce something we want to keep.
        if (r2 && eventId) {
          const body = {
            event_id: eventId,
            model: (model as { modelId?: string }).modelId,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            latency_ms: Date.now() - startedAtMs,
            request: { params: redactParams(params) },
            error: err instanceof Error ? err.message : String(err),
            error_class: err instanceof Error ? err.name : undefined,
          };
          void r2
            .put(
              `t/${ctx.tenant_id}/sessions/${ctx.session_id}/llm/${eventId}.json`,
              JSON.stringify(body),
              { httpMetadata: { contentType: "application/json" } },
            )
            .catch((putErr) => {
              const m = putErr instanceof Error ? putErr.message : String(putErr);
              console.warn(`[llm-log] R2 PUT (error path) failed: ${m}`);
            });
        }
        throw err;
      }

      // Tee the stream: pass chunks through to the harness, accumulate
      // a copy for the R2 PUT. AI SDK's stream parts are JSON-shaped
      // typed objects (text, reasoning, tool-call, etc.), not raw
      // bytes — so we serialize each one verbatim into an array. The
      // resulting body is bounded by step.content size; not an issue
      // for typical Anthropic responses. Tool-result payloads stay in
      // the events table separately.
      if (!r2 || !eventId) return result;

      const collected: unknown[] = [];
      const teed = result.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            collected.push(chunk);
            controller.enqueue(chunk);
          },
          async flush() {
            const body = {
              event_id: eventId,
              model: (model as { modelId?: string }).modelId,
              started_at: startedAt,
              ended_at: new Date().toISOString(),
              latency_ms: Date.now() - startedAtMs,
              request: {
                params: redactParams(params),
                provider_request: result.request ?? null,
              },
              response: {
                stream_parts: collected,
                response_meta: result.response ?? null,
              },
            };
            try {
              await r2.put(
                `t/${ctx.tenant_id}/sessions/${ctx.session_id}/llm/${eventId}.json`,
                JSON.stringify(body),
                { httpMetadata: { contentType: "application/json" } },
              );
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              console.warn(`[llm-log] R2 PUT failed for ${eventId}: ${m}`);
            }
          },
        }),
      );

      return { ...result, stream: teed };
    },

    wrapGenerate: async ({ doGenerate, params, model }) => {
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      const r2 = ctx.r2;
      const eventId = ctx.spanIdResolver();
      let result;
      try {
        result = await doGenerate();
      } catch (err) {
        if (r2 && eventId) {
          const body = {
            event_id: eventId,
            model: (model as { modelId?: string }).modelId,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            latency_ms: Date.now() - startedAtMs,
            request: { params: redactParams(params) },
            error: err instanceof Error ? err.message : String(err),
            error_class: err instanceof Error ? err.name : undefined,
          };
          void r2
            .put(
              `t/${ctx.tenant_id}/sessions/${ctx.session_id}/llm/${eventId}.json`,
              JSON.stringify(body),
              { httpMetadata: { contentType: "application/json" } },
            )
            .catch((putErr) => {
              const m = putErr instanceof Error ? putErr.message : String(putErr);
              console.warn(`[llm-log] R2 PUT (error path) failed: ${m}`);
            });
        }
        throw err;
      }

      if (!r2 || !eventId) return result;
      const body = {
        event_id: eventId,
        model: (model as { modelId?: string }).modelId,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        latency_ms: Date.now() - startedAtMs,
        request: { params: redactParams(params) },
        response: result,
      };
      try {
        await r2.put(
          `t/${ctx.tenant_id}/sessions/${ctx.session_id}/llm/${eventId}.json`,
          JSON.stringify(body),
          { httpMetadata: { contentType: "application/json" } },
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[llm-log] R2 PUT failed for ${eventId}: ${m}`);
      }
      return result;
    },
  };
}

/**
 * Build the R2 key the read endpoint uses to look up a logged call.
 * Single source of truth so the writer + reader can't drift.
 */
export function llmLogKey(tenant_id: string, session_id: string, event_id: string): string {
  return `t/${tenant_id}/sessions/${session_id}/llm/${event_id}.json`;
}
