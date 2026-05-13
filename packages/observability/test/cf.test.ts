import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCfLogger } from "../src/logger/cf";
import {
  createCfMetricsRecorder,
  type AnalyticsBinding,
} from "../src/metrics/cf";
import { NoopLogger, NoopMetricsRecorder, NoopTracer } from "../src/root";

describe("cf logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emits structured JSON", () => {
    const log = createCfLogger();
    log.info({ op: "x.y", n: 1 }, "hi");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(line.op).toBe("x.y");
    expect(line.n).toBe(1);
    expect(line.msg).toBe("hi");
    expect(line.level).toBe("info");
    expect(typeof line.ts).toBe("string");
  });

  it("merges child bindings", () => {
    const child = createCfLogger().child({ tenant_id: "t1" });
    child.warn({ extra: 2 }, "uhoh");
    const line = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(line.tenant_id).toBe("t1");
    expect(line.extra).toBe(2);
    expect(line.level).toBe("warn");
  });

  it("normalizes errors via err key", () => {
    const log = createCfLogger();
    log.error({ err: new Error("boom") }, "nope");
    const line = JSON.parse(errSpy.mock.calls[0]?.[0] as string);
    expect(line.err.name).toBe("Error");
    expect(line.err.message).toBe("boom");
    expect(line.err.stack).toBeDefined();
  });

  it("respects level threshold", () => {
    const log = createCfLogger({ level: "warn" });
    log.info("nope");
    log.warn("yes");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cf metrics recorder", () => {
  it("writes events with the legacy schema (column positions preserved)", () => {
    const calls: unknown[] = [];
    const ae: AnalyticsBinding = {
      writeDataPoint: (e) => calls.push(e),
    };
    const m = createCfMetricsRecorder({ events: ae });
    m.recordEvent({
      op: "session.create",
      tenant_id: "t1",
      session_id: "s1",
      duration_ms: 12,
    });
    expect(calls).toHaveLength(1);
    const point = calls[0] as {
      indexes: string[]; blobs: string[]; doubles: number[];
    };
    expect(point.indexes).toEqual(["session.create"]);
    expect(point.blobs[0]).toBe("session.create");
    expect(point.blobs[1]).toBe("t1");
    expect(point.blobs[2]).toBe("s1");
    expect(point.doubles[0]).toBe(12);
  });

  it("counters/histograms emit on the metrics dataset when set", () => {
    const calls: unknown[] = [];
    const metrics: AnalyticsBinding = {
      writeDataPoint: (e) => calls.push(e),
    };
    const m = createCfMetricsRecorder({ events: null, metrics });
    m.counter("http_requests_total", 1, { route: "/v1/agents", status: 200 });
    expect(calls).toHaveLength(1);
    const point = calls[0] as { blobs: string[]; doubles: number[] };
    expect(point.blobs[0]).toBe("metric:http_requests_total");
    expect(point.blobs[2]).toBe("counter");
    expect(point.doubles[0]).toBe(1);
  });

  it("noops when binding missing", () => {
    const m = createCfMetricsRecorder({ events: null });
    expect(() => m.recordEvent({ op: "x" })).not.toThrow();
    expect(() => m.counter("x")).not.toThrow();
  });
});

describe("noop fallbacks", () => {
  it("noop logger never throws", () => {
    const l = new NoopLogger();
    expect(() => l.info("x")).not.toThrow();
    expect(() => l.child({}).warn("y")).not.toThrow();
  });
  it("noop metrics never throws", () => {
    const m = new NoopMetricsRecorder();
    expect(() => m.counter("x")).not.toThrow();
    expect(() => m.recordEvent({ op: "x" })).not.toThrow();
  });
  it("noop tracer runs the active fn synchronously", async () => {
    const t = new NoopTracer();
    const r = await t.startActiveSpan("x", () => 7);
    expect(r).toBe(7);
  });
});
