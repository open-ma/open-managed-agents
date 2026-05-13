// CF tracer — no-op for now. OTel-on-workerd is rough today; CF has its
// own observability story (Workers Logs + Analytics Engine + Workers
// Tracing). When CF tracing matures we swap in a thin adapter behind the
// same Tracer interface.

import { NoopTracer } from "../root";
import type { Tracer } from "../types";

export function createCfTracer(): Tracer {
  return new NoopTracer();
}
