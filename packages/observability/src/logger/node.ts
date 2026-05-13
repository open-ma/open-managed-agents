// Node logger — wraps pino. Pretty mode under TTY+!production, JSON
// otherwise. pino is loaded lazily so workerd / CF builds don't pull it.
//
// LOG_LEVEL env wins over the spec. Drop-in compatible with the CfLogger
// JSON shape: same level set, same `msg` key, structured bindings flattened
// at the root.

import type { Logger, LogBindings, LogLevel, LoggerSpec } from "../types";

const VALID_LEVELS = new Set<LogLevel>([
  "trace", "debug", "info", "warn", "error", "fatal",
]);

export interface NodeLoggerOptions extends LoggerSpec {
  /** Force pretty mode (default: auto — pretty if stdout is a TTY and
   *  NODE_ENV !== "production"). */
  pretty?: boolean;
}

export async function createNodeLogger(opts: NodeLoggerOptions = {}): Promise<Logger> {
  const envLevel = (process.env.LOG_LEVEL ?? "").toLowerCase();
  const level: LogLevel =
    VALID_LEVELS.has(envLevel as LogLevel)
      ? (envLevel as LogLevel)
      : (opts.level ?? "info");
  const pretty =
    opts.pretty
    ?? (process.env.NODE_ENV !== "production" && Boolean(process.stdout.isTTY));

  // Lazy import: pino is a peer dep so CF tsc doesn't pull it.
  const pinoMod = await import("pino").catch(() => null);
  if (!pinoMod) {
    // Fallback to a console-backed shim — keeps the app working when
    // pino isn't installed (e.g. dev sandbox without optional deps).
    const { createCfLogger } = await import("./cf");
    return createCfLogger(opts);
  }
  // pino ships dual ESM/CJS; the runtime shape is "default function on namespace
  // OR namespace IS the function" depending on bundler. Cast through any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pino: any = (pinoMod as any).default ?? pinoMod;

  const transport = pretty
    ? {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", singleLine: false },
      }
    : undefined;

  const inst = pino({
    level,
    base: opts.bindings ?? null,
    ...(transport ? { transport } : {}),
  });

  return wrapPino(inst);
}

function wrapPino(p: import("pino").Logger): Logger {
  return {
    trace: (a: unknown, b?: unknown) => callPino(p, "trace", a, b),
    debug: (a: unknown, b?: unknown) => callPino(p, "debug", a, b),
    info: (a: unknown, b?: unknown) => callPino(p, "info", a, b),
    warn: (a: unknown, b?: unknown) => callPino(p, "warn", a, b),
    error: (a: unknown, b?: unknown) => callPino(p, "error", a, b),
    fatal: (a: unknown, b?: unknown) => callPino(p, "fatal", a, b),
    child: (bindings: LogBindings) => wrapPino(p.child(bindings)),
  } as Logger;
}

function callPino(
  p: import("pino").Logger,
  level: LogLevel,
  a: unknown,
  b: unknown,
): void {
  // pino accepts the (obj, msg) and (msg) forms natively — pass through.
  if (typeof a === "string") p[level](a);
  else if (typeof b === "string") p[level](a as object, b);
  else p[level](a as object);
}
