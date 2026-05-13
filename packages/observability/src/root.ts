// Process-wide root-logger registry so package-level code can call
// `getLogger("memory-store")` without taking a Logger as a constructor
// arg. main-node bootstrap calls `setRootLogger(...)` once; packages
// pull a child logger off it lazily.

import type {
  Logger,
  LogBindings,
  MetricsRecorder,
  Tracer,
  Span,
  SpanOptions,
  RecordableEvent,
} from "./types";

export class NoopLogger implements Logger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  child(): Logger {
    return this;
  }
}

export class NoopMetricsRecorder implements MetricsRecorder {
  counter(): void {}
  histogram(): void {}
  gauge(): void {}
  recordEvent(_event: RecordableEvent): void {}
}

export class NoopSpan implements Span {
  setAttribute(): void {}
  setAttributes(): void {}
  recordException(): void {}
  setStatus(): void {}
  end(): void {}
}

export class NoopTracer implements Tracer {
  startSpan(_name: string, _options?: SpanOptions): Span {
    return new NoopSpan();
  }
  startActiveSpan<T>(
    _name: string,
    fn: (span: Span) => T | Promise<T>,
    _options?: SpanOptions,
  ): T | Promise<T> {
    return fn(new NoopSpan());
  }
}

let rootLogger: Logger = new NoopLogger();

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

/** `getLogger("memory-store")` returns a child of the bootstrap logger
 *  bound with `module: "memory-store"`. Until `setRootLogger` runs (e.g.
 *  in tests or pre-bootstrap code) it returns a noop child. */
export function getLogger(module: string, extra?: LogBindings): Logger {
  return rootLogger.child({ module, ...(extra ?? {}) });
}
