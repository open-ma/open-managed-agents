import type { ManagedEnvironmentWorker } from "@open-managed-agents/managed-runtime-host";
import { timingSafeEqual } from "node:crypto";

export interface WebFetchApplication {
  fetch(request: Request): Response | Promise<Response>;
}

export interface VercelControlPlaneHandlerOptions {
  loadApi(): Promise<WebFetchApplication>;
  loadEnvironmentWorker(): Promise<ManagedEnvironmentWorker>;
  waitUntil(promise: Promise<unknown>): void;
  cronSecret?: string;
  pollTimeoutMs?: number;
  onError?(error: unknown): void;
}

export interface VercelControlPlaneHandler extends WebFetchApplication {}

const webhookPath = "/api/openma/environment/webhook";
const pollPath = "/api/openma/environment/poll";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function methodNotAllowed(method: string): Response {
  return json({ error: "method_not_allowed" }, 405, { allow: method });
}

function sameSecret(actual: string | null, expected: string): boolean {
  const prefix = "Bearer ";
  if (actual === null || !actual.startsWith(prefix)) return false;
  const actualBytes = Buffer.from(actual.slice(prefix.length));
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function withTimeout<T>(
  requestSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Vercel poll deadline reached", "TimeoutError"));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortFromRequest);
  }
}

/**
 * Thin Vercel request boundary. Session APIs—including mid-turn ACP steer—are
 * delegated byte-for-byte to the canonical control plane. Only the signed
 * Environment webhook and authenticated bounded fallback poll are intercepted.
 */
export function createVercelControlPlaneHandler(
  options: VercelControlPlaneHandlerOptions,
): VercelControlPlaneHandler {
  const pollTimeoutMs = options.pollTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs <= 0) {
    throw new RangeError("pollTimeoutMs must be a positive integer");
  }
  let api: Promise<WebFetchApplication> | undefined;
  let environmentWorker: Promise<ManagedEnvironmentWorker> | undefined;
  const loadApi = () => api ??= options.loadApi();
  const loadWorker = () => environmentWorker ??= options.loadEnvironmentWorker();

  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === webhookPath) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        let worker: ManagedEnvironmentWorker;
        try {
          worker = await loadWorker();
        } catch (error) {
          options.onError?.(error);
          return json({ error: "environment_worker_unavailable" }, 503);
        }
        try {
          const outcome = worker.handleWebhook({
            body: await request.text(),
            headers: headersRecord(request.headers),
            waitUntil: (promise) => options.waitUntil(promise),
          });
          return json({ type: outcome.type, event_id: outcome.eventId }, 202);
        } catch (error) {
          options.onError?.(error);
          return json({ error: "invalid_environment_webhook" }, 400);
        }
      }

      if (path === pollPath) {
        if (request.method !== "GET" && request.method !== "POST") {
          return methodNotAllowed("GET, POST");
        }
        const cronSecret = options.cronSecret?.trim();
        if (!cronSecret) return json({ error: "cron_not_configured" }, 503);
        if (!sameSecret(request.headers.get("authorization"), cronSecret)) {
          return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
        }
        try {
          const worker = await loadWorker();
          await withTimeout(request.signal, pollTimeoutMs, (signal) => worker.drain(signal));
          return json({ ok: true }, 200);
        } catch (error) {
          options.onError?.(error);
          return json({ error: "environment_poll_failed" }, 503);
        }
      }

      return (await loadApi()).fetch(request);
    },
  };
}
