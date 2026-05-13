// Workers logger — JSON-line writer onto console.{log,warn,error}.
// Wrangler tail / Logpush surface these. Intentionally identical wire shape
// to packages/shared/src/log.ts so the migration to the new Logger surface
// is a no-op for downstream log aggregators.

import type { Logger, LogBindings, LogLevel, LoggerSpec } from "../types";
import { normalizeErr } from "../errors";

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

interface CfLoggerOptions extends LoggerSpec {
  /** When set, debug messages are sampled at this fraction (0..1).
   *  Used to suppress noisy debug logs in production without dropping
   *  warn/error visibility. Default 1 (no sampling). */
  debugSampleRate?: number;
}

export function createCfLogger(opts: CfLoggerOptions = {}): Logger {
  const minLevel = LEVEL_RANK[opts.level ?? "info"];
  const debugSample = opts.debugSampleRate ?? 1;
  return new CfLogger(minLevel, debugSample, opts.bindings ?? {});
}

class CfLogger implements Logger {
  constructor(
    private readonly minLevel: number,
    private readonly debugSample: number,
    private readonly bindings: LogBindings,
  ) {}

  trace(...a: [string] | [LogBindings, string?]) { this.emit("trace", a); }
  debug(...a: [string] | [LogBindings, string?]) { this.emit("debug", a); }
  info(...a: [string] | [LogBindings, string?]) { this.emit("info", a); }
  warn(...a: [string] | [LogBindings, string?]) { this.emit("warn", a); }
  error(...a: [string] | [LogBindings, string?]) { this.emit("error", a); }
  fatal(...a: [string] | [LogBindings, string?]) { this.emit("fatal", a); }

  child(b: LogBindings): Logger {
    return new CfLogger(this.minLevel, this.debugSample, { ...this.bindings, ...b });
  }

  private emit(level: LogLevel, args: [string] | [LogBindings, string?]): void {
    if (LEVEL_RANK[level] < this.minLevel) return;
    if (level === "debug" && this.debugSample < 1 && Math.random() > this.debugSample) return;

    const obj = typeof args[0] === "string" ? {} : args[0];
    const msg = typeof args[0] === "string" ? args[0] : (args[1] ?? "");

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
    };
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      entry[k] = k === "err" ? normalizeErr(v) : v;
    }
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg, _serialize_failed: true });
    }
    if (level === "error" || level === "fatal") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
