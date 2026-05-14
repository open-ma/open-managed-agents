const BASE = "";

import { useToast } from "../components/Toast";

/** Parse an error message out of an API response body. The server now emits
 *  the Anthropic-compatible envelope `{type:"error", error:{type, message},
 *  request_id}`; older endpoints (and external callers) may still return the
 *  legacy `{error: "<string>"}`. Handle both so toasts render a real message
 *  in either case. */
export function readApiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") {
      const m = (e as { message?: unknown }).message;
      if (typeof m === "string") return m;
    }
  }
  return `HTTP ${status}`;
}

/** localStorage key for the active tenant the Console wants to operate as.
 *  Sent on every /v1/* request as `x-active-tenant`; the backend validates
 *  membership before honoring. Single-tenant users never write this. */
export const ACTIVE_TENANT_KEY = "oma_active_tenant_id";

export function getActiveTenantId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_TENANT_KEY, id);
    else localStorage.removeItem(ACTIVE_TENANT_KEY);
  } catch {
    // localStorage may be disabled (private mode, embedded webview);
    // the user just won't get the multi-tenant switcher.
  }
}

/** Endpoints whose 401/403 are part of normal app flow and should NOT
 *  surface as a toast. /auth-info is checked on every page load to decide
 *  whether to show the login screen — a 401 means "not logged in", which
 *  the login screen already communicates. /v1/me 401 is handled the same
 *  way by the sidebar bootstrapping path. */
const SILENT_AUTH_PATHS = ["/auth-info", "/v1/me"];

function shouldSilenceAuthError(path: string, status: number): boolean {
  if (status !== 401 && status !== 403) return false;
  return SILENT_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
}

export function useApi() {
  const { toast } = useToast();

  async function api<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const activeTenant = getActiveTenantId();
    // Don't auto-set JSON content-type for FormData — the browser must add
    // multipart boundaries itself, and a manually set content-type without
    // the boundary breaks parsing on the server.
    const isFormData = init?.body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          ...(init?.body && !isFormData ? { "content-type": "application/json" } : {}),
          // Pin the workspace for this request. Backend validates membership;
          // a stale value (deleted tenant, removed membership) yields 403 and
          // the sidebar's catch-and-retry path clears + reloads.
          ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
          ...init?.headers,
        },
      });
    } catch (err) {
      // Network-level failure (DNS, CORS, offline, request aborted by route
      // change). Show a single toast — the caller's catch likely just renders
      // an empty state otherwise.
      const msg = err instanceof Error ? err.message : "network error";
      // Don't toast aborted requests (component unmount is a normal flow).
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        // User-facing toast: skip the METHOD path: prefix (debug noise);
        // log the full thing to console for dev triage.
        console.error(`[api] ${(init?.method || "GET")} ${path}: ${msg}`);
        toast(`Network error: ${msg}`, "error");
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = readApiErrorMessage(body, res.status);

      // Safety net for stale-tenant lockout. The primary fix is in Login.tsx
      // (clears localStorage on every successful auth transition). This still
      // catches edge cases the login fix can't:
      //   - User opens 2 tabs, signs out + signs in as a different user in
      //     tab A; tab B still has the old user's tenant pin in localStorage
      //   - A tenant the user belonged to gets revoked while they're already
      //     logged in
      //   - Cross-domain edge cases where localStorage carries over via
      //     extension / shared profile sync
      // Reload-loop guard prevents bouncing if 403 is from some unrelated
      // membership check (e.g. POST /v1/me/cli-tokens with an explicit body
      // tenant_id that's not ours).
      if (
        res.status === 403 &&
        activeTenant &&
        message.includes("Not a member") &&
        !sessionStorage.getItem("oma_tenant_self_heal")
      ) {
        sessionStorage.setItem("oma_tenant_self_heal", "1");
        setActiveTenantId(null);
        toast("Reset stored workspace pin (was unrecognized) — reloading", "info");
        // Give the toast a tick to render before navigation.
        setTimeout(() => location.reload(), 250);
        throw new Error(message);
      }

      // Surface non-OK responses to the user. Silently dropped errors had us
      // chasing "why don't I see anything" issues for far too long; almost
      // every endpoint failure here is something the user could act on
      // (re-login, switch tenant, retry) once they know it happened.
      //
      // Toast format: server message verbatim. The previous shape prefixed
      // the API path (e.g. "/v1/sessions: Insufficient balance.") which
      // leaked debug info into UX. Path + status still go to console for
      // dev triage.
      if (!shouldSilenceAuthError(path, res.status)) {
        console.error(`[api] ${res.status} ${path}: ${message}`);
        toast(message, "error");
      }
      // Attach status so callers can branch on specific cases
      // (e.g. SessionsList redirects to /billing on 402).
      const e = new Error(message) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    // Successful response — clear the self-heal sentinel so a future stale
    // tenant can self-heal again later in the same browser session.
    sessionStorage.removeItem("oma_tenant_self_heal");
    return res.json() as Promise<T>;
  }

  function streamEvents(
    sessionId: string,
    onEvent: (event: Record<string, unknown>) => void,
    signal?: AbortSignal
  ) {
    const activeTenant = getActiveTenantId();
    // SSE endpoint goes through the same auth middleware so it needs the
    // header too. fetch() lets us set it; EventSource wouldn't.
    //
    // Console opts into both `chunks` (token-by-token rendering, pending
    // queue events, session.warning, extra spans) and `replay=1` (full
    // history on connect — Console renders the persistent timeline view
    // and the dedup keyset at SessionDetail.tsx:108-121 already handles
    // any seq-overlap from concurrent live broadcasts).
    //
    // Default endpoint behavior is Anthropic-spec — third-party clients
    // using @anthropic-ai/sdk against an OMA server get a clean stream
    // without these flags. See SPEC_EVENT_TYPES in @open-managed-agents/api-types.
    fetch(`/v1/sessions/${sessionId}/events/stream?include=chunks&replay=1`, {
      credentials: "include",
      signal,
      headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
    }).then(async (res) => {
      if (!res.ok) {
        // Surface stream open failures the same way as regular API calls —
        // previously the .then closure swallowed everything, so a 401 / 500
        // on the SSE handshake meant the timeline just never updated.
        const body = await res.json().catch(() => ({}));
        const message = readApiErrorMessage(body, res.status);
        toast(`/v1/sessions/${sessionId}/events/stream: ${message}`, "error");
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          try {
            onEvent(JSON.parse(chunk.slice(6)));
          } catch {}
        }
      }
    }).catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "network error";
      toast(`stream events: ${msg}`, "error");
    });
  }

  return { api, streamEvents };
}
