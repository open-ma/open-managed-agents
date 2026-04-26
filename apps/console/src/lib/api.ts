const BASE = "";

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

export function useApi() {
  async function api<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const activeTenant = getActiveTenantId();
    const res = await fetch(`${BASE}${path}`, {
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
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error || `HTTP ${res.status}`
      );
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
    });
  }

  return { api, streamEvents };
}
