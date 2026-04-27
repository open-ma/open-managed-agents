import { OpenMAError } from "./errors.js";

export interface ClientOptions {
  /** API key (`oma_...`). Required unless `bearer` is passed (cookie auth). */
  apiKey?: string;
  /** Browser cookie auth — for embedding the SDK in the Console UI. */
  bearer?: string;
  /** Base URL of the openma deployment. Defaults to https://openma.dev. */
  baseUrl?: string;
  /** Override the User-Agent header. The default identifies as
   *  OpenManagedAgents-SDK; some hardened deployments (Cloudflare bot
   *  fight) require a Mozilla-style UA — pass that here if you hit 1010. */
  userAgent?: string;
  /** Active tenant id. Sent as `x-active-tenant`; the backend validates
   *  membership. Only useful for cookie-auth users on multi-tenant
   *  workspaces. API-key users authenticate as the key's tenant. */
  activeTenantId?: string;
  /** Custom fetch — useful for tests, proxies, or runtimes where the
   *  global fetch is missing. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/**
 * The base HTTP client. Used directly by every resource. Resource
 * classes are thin sugar around `request(method, path, body?)`.
 */
export class Client {
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey && !opts.bearer) {
      throw new TypeError("OpenMA: provide either `apiKey` or `bearer`");
    }
    this.baseUrl = (opts.baseUrl ?? "https://openma.dev").replace(/\/+$/, "");
    this.fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = {
      "user-agent": opts.userAgent
        ?? "Mozilla/5.0 (compatible; OpenManagedAgents-SDK/0.1; +https://openma.dev)",
      ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.activeTenantId ? { "x-active-tenant": opts.activeTenantId } : {}),
    };
  }

  /** Execute a JSON request — throws OpenMAError on non-2xx, parses
   *  JSON otherwise. Use `raw()` instead for streaming responses. */
  async request<T = unknown>(
    method: string,
    path: string,
    init?: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; signal?: AbortSignal },
  ): Promise<T> {
    const res = await this.raw(method, path, {
      ...init,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    });
    const text = await res.text();
    if (!text) return undefined as T;
    try { return JSON.parse(text) as T; }
    catch { throw new OpenMAError(res.status, text, res.url); }
  }

  /** Lower-level — returns the raw Response. Used by SSE consumers
   *  (sessions.chat, sessions.tail) so they can drive the byte stream
   *  themselves. Auth, query-string, and 4xx-throwing are still applied. */
  async raw(
    method: string,
    path: string,
    init?: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      query?: Record<string, string | number | boolean | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = this.buildUrl(path, init?.query);
    const res = await this.fetcher(url, {
      method,
      headers: { ...this.headers, ...init?.headers },
      body: init?.body ?? undefined,
      signal: init?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OpenMAError(res.status, text, res.url);
    }
    return res;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}
