const BASE = "";

import { useToast } from "../components/Toast";

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
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
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
        toast(`${(init?.method || "GET")} ${path}: ${msg}`, "error");
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const message = (body as { error?: string }).error || `HTTP ${res.status}`;
      // Surface non-OK responses to the user. Silently dropped errors had us
      // chasing "why don't I see anything" issues for far too long; almost
      // every endpoint failure here is something the user could act on
      // (re-login, switch tenant, retry) once they know it happened.
      if (!shouldSilenceAuthError(path, res.status)) {
        toast(`${path}: ${message}`, "error");
      }
      throw new Error(message);
    }
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
    fetch(`/v1/sessions/${sessionId}/events/stream`, {
      credentials: "include",
      signal,
      headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
    }).then(async (res) => {
      if (!res.ok) {
        // Surface stream open failures the same way as regular API calls —
        // previously the .then closure swallowed everything, so a 401 / 500
        // on the SSE handshake meant the timeline just never updated.
        const body = await res.json().catch(() => ({}));
        const message = (body as { error?: string }).error || `HTTP ${res.status}`;
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
