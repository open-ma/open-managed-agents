// @open-managed-agents/observability — runtime-agnostic Logger, MetricsRecorder,
// Tracer used by the rest of the codebase. CF + Node ship distinct adapters
// behind the same interface. Hono middleware (requestMetrics, tracerMiddleware)
// lives in ./middleware.

export type {
  Logger,
  LogBindings,
  LogLevel,
  LoggerSpec,
  MetricsRecorder,
  Tracer,
  Span,
  SpanAttributes,
  SpanOptions,
  RecordableEvent,
} from "./types";

export {
  NoopLogger,
  NoopMetricsRecorder,
  NoopTracer,
  getLogger,
  setRootLogger,
} from "./root";

export { errFields } from "./errors";

export { requestMetrics, tracerMiddleware } from "./middleware";
export type { RequestMetricsOptions, TracerMiddlewareOptions } from "./middleware";
