// Plain HTTP client backed by the runtime's global fetch.
//
// Keeps retry/backoff conservative — Linear's GraphQL endpoint returns 429
// with Retry-After on rate limit, and 5xx for transient infra issues. Both
// are retried with exponential backoff up to a cap.

import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "@open-managed-agents/integrations-core";

export interface WorkerHttpClientOptions {
  /** Max retries on 5xx/429. Default 2 (so up to 3 attempts). */
  maxRetries?: number;
  /** Base delay in ms; doubled each attempt. Default 250. */
  baseDelayMs?: number;
  /** Total deadline in ms across all attempts. Default 15_000. */
  totalTimeoutMs?: number;
}

export class WorkerHttpClient implements HttpClient {
  constructor(private readonly opts: WorkerHttpClientOptions = {}) {}

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    const maxRetries = this.opts.maxRetries ?? 2;
    const baseDelay = this.opts.baseDelayMs ?? 250;
    const deadline = Date.now() + (this.opts.totalTimeoutMs ?? 15_000);

    let attempt = 0;
    let lastResponse: HttpResponse | null = null;

    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (lastResponse) return lastResponse;
        throw new Error(`HTTP ${req.method} ${req.url}: total timeout exceeded`);
      }

      const res = await this.doFetch(req, remaining);
      lastResponse = res;

      if (res.status < 500 && res.status !== 429) return res;
      if (attempt >= maxRetries) return res;

      const retryAfterMs = parseRetryAfter(res.headers["retry-after"]);
      const backoff = retryAfterMs ?? baseDelay * Math.pow(2, attempt);
      const delay = Math.min(backoff, Math.max(0, deadline - Date.now()));
      if (delay <= 0) return res;
      await sleep(delay);
      attempt += 1;
    }
  }

  private async doFetch(req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
      });
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const body = await res.text();
      return { status: res.status, headers, body };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = parseFloat(value);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const epoch = Date.parse(value);
  if (!Number.isNaN(epoch)) return Math.max(0, epoch - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
