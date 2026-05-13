import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestMetrics, tracerMiddleware } from "../src/middleware";
import { NoopMetricsRecorder, NoopTracer } from "../src/root";
import type { MetricTags, RecordableEvent } from "../src/types";

class CapturingRecorder extends NoopMetricsRecorder {
  counters: Array<{ name: string; value: number; tags?: MetricTags }> = [];
  histograms: Array<{ name: string; value: number; tags?: MetricTags }> = [];
  events: RecordableEvent[] = [];
  override counter(name: string, value = 1, tags?: MetricTags) {
    this.counters.push({ name, value, tags });
  }
  override histogram(name: string, value: number, tags?: MetricTags) {
    this.histograms.push({ name, value, tags });
  }
  override recordEvent(event: RecordableEvent) {
    this.events.push(event);
  }
}

describe("requestMetrics middleware", () => {
  it("records a counter + histogram + event per request, with the matched route pattern", async () => {
    const recorder = new CapturingRecorder();
    const app = new Hono();
    app.use("*", requestMetrics({ recorder }));
    app.get("/v1/agents/:id", (c) => c.json({ id: c.req.param("id") }));
    const res = await app.request("/v1/agents/abc123");
    expect(res.status).toBe(200);
    expect(recorder.counters).toHaveLength(1);
    expect(recorder.counters[0]?.name).toBe("http_requests_total");
    // Route pattern should be /v1/agents/:id, NOT the literal /v1/agents/abc123
    expect(recorder.counters[0]?.tags?.route).toBe("/v1/agents/:id");
    expect(recorder.counters[0]?.tags?.method).toBe("GET");
    expect(recorder.counters[0]?.tags?.status).toBe(200);
    expect(recorder.histograms).toHaveLength(1);
    expect(recorder.histograms[0]?.name).toBe("http_request_duration_seconds");
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]?.op).toBe("http.GET./v1/agents/:id");
  });

  it("flags 4xx/5xx in the recordEvent error_name (preserves CF behavior)", async () => {
    const recorder = new CapturingRecorder();
    const app = new Hono();
    app.use("*", requestMetrics({ recorder }));
    app.get("/oops", (c) => c.json({ error: "boom" }, 500));
    const res = await app.request("/oops");
    expect(res.status).toBe(500);
    expect(recorder.events[0]?.error_name).toBe("500");
  });

  it("captures latency on thrown handler", async () => {
    const recorder = new CapturingRecorder();
    const app = new Hono();
    app.use("*", requestMetrics({ recorder }));
    app.get("/throw", () => {
      throw new Error("kaboom");
    });
    // Hono converts unhandled into 500 via default onError; the middleware
    // re-throws so its catch path fires too.
    await app.request("/throw").catch(() => {});
    expect(recorder.counters.some((c) => c.tags?.status === 500)).toBe(true);
    expect(recorder.events.some((e) => e.error_message === "kaboom")).toBe(true);
  });
});

describe("tracerMiddleware", () => {
  it("invokes the active span with the request context (noop tracer is fine)", async () => {
    const tracer = new NoopTracer();
    const app = new Hono();
    let sawSpan = false;
    app.use("*", tracerMiddleware({ tracer }));
    app.get("/x", (c) => {
      // span is set on the var bag for handlers
      sawSpan = (c as unknown as { var: { span?: unknown } }).var.span !== undefined;
      return c.text("ok");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(200);
    expect(sawSpan).toBe(true);
  });
});
