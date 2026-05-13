// CF metrics recorder — wraps the Analytics Engine binding. counter/
// histogram/gauge map onto AE rows so the CF dashboards (Grafana over the
// SQL API) see a single oma_metrics dataset; recordEvent keeps the legacy
// oma_events shape so existing queries don't break.

import type {
  MetricsRecorder,
  MetricTags,
  RecordableEvent,
} from "../types";

export interface AnalyticsBinding {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

const MAX_MESSAGE_LEN = 500;

export interface CfMetricsOptions {
  events: AnalyticsBinding | undefined | null;
  /** Optional separate dataset for free-form metrics. CF dashboards may
   *  ignore this; OK to leave undefined. */
  metrics?: AnalyticsBinding | undefined | null;
}

export function createCfMetricsRecorder(opts: CfMetricsOptions): MetricsRecorder {
  return new CfMetricsRecorder(opts.events ?? null, opts.metrics ?? null);
}

class CfMetricsRecorder implements MetricsRecorder {
  constructor(
    private readonly events: AnalyticsBinding | null,
    private readonly metrics: AnalyticsBinding | null,
  ) {}

  counter(name: string, value = 1, tags?: MetricTags): void {
    this.writeMetric("counter", name, value, tags);
  }
  histogram(name: string, value: number, tags?: MetricTags): void {
    this.writeMetric("histogram", name, value, tags);
  }
  gauge(name: string, value: number, tags?: MetricTags): void {
    this.writeMetric("gauge", name, value, tags);
  }

  recordEvent(event: RecordableEvent): void {
    if (!this.events) return;
    try {
      // Schema preserved verbatim from packages/shared/src/metrics.ts —
      // dashboards depend on column positions.
      this.events.writeDataPoint({
        indexes: [event.op],
        blobs: [
          event.op,
          event.tenant_id ?? "",
          event.session_id ?? "",
          event.agent_id ?? "",
          event.error_name ?? "",
          (event.error_message ?? "").slice(0, MAX_MESSAGE_LEN),
        ],
        doubles: [event.duration_ms ?? 0],
      });
    } catch {
      // Observability writes must never bubble — same trade-off as before.
    }
  }

  private writeMetric(
    kind: "counter" | "histogram" | "gauge",
    name: string,
    value: number,
    tags?: MetricTags,
  ): void {
    const dest = this.metrics ?? this.events;
    if (!dest) return;
    try {
      // tag keys/values are flattened k=v|k=v so the same dataset can host
      // arbitrary metrics without per-name schema. Dashboards parse blob1
      // (`metric:<name>`) + blob2 (the tags string).
      const tagsStr = tags
        ? Object.entries(tags).map(([k, v]) => `${k}=${v}`).join("|")
        : "";
      dest.writeDataPoint({
        indexes: [`metric:${name}`],
        blobs: [`metric:${name}`, tagsStr, kind],
        doubles: [value],
      });
    } catch {
      // ditto.
    }
  }
}
