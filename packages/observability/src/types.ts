// Core types shared by all adapters.

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogBindings = Record<string, unknown>;

/**
 * Pino-compatible logger surface. Each method accepts either:
 *   logger.info("msg")
 *   logger.info({ op: "x.y" }, "msg")
 * `child(bindings)` returns a logger that merges bindings into every emit.
 */
export interface Logger {
  trace(msg: string): void;
  trace(obj: LogBindings, msg?: string): void;
  debug(msg: string): void;
  debug(obj: LogBindings, msg?: string): void;
  info(msg: string): void;
  info(obj: LogBindings, msg?: string): void;
  warn(msg: string): void;
  warn(obj: LogBindings, msg?: string): void;
  error(msg: string): void;
  error(obj: LogBindings, msg?: string): void;
  fatal(msg: string): void;
  fatal(obj: LogBindings, msg?: string): void;
  child(bindings: LogBindings): Logger;
}

/** Construction-time spec for adapters. Kept narrow: level + bindings. */
export interface LoggerSpec {
  level?: LogLevel;
  bindings?: LogBindings;
}

export type MetricTags = Record<string, string | number>;

/**
 * Generalized analog of `recordEvent` from packages/shared/src/metrics.ts —
 * still accepted with the same arg shape (kept for compatibility), but the
 * underlying recorder also supports OpenMetrics-style counter/histogram/gauge.
 */
export interface RecordableEvent {
  op: string;
  tenant_id?: string;
  session_id?: string;
  agent_id?: string;
  error_name?: string;
  error_message?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

export interface MetricsRecorder {
  counter(name: string, value?: number, tags?: MetricTags): void;
  histogram(name: string, value: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
  /** AE-shaped event write. CF wires to Analytics Engine; Node mirrors the
   *  event into a generic `oma_events_total{op,...}` counter. */
  recordEvent(event: RecordableEvent): void;
}

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface SpanOptions {
  attributes?: SpanAttributes;
}

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: SpanAttributes): void;
  recordException(err: unknown): void;
  setStatus(status: { code: 0 | 1 | 2; message?: string }): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions,
  ): T | Promise<T>;
}
