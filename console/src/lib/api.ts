import { useAuth } from "./auth";

const BASE = "";

export function useApi() {
  const { apiKey } = useAuth();

  async function api<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "x-api-key": apiKey,
        ...(init?.body ? { "content-type": "application/json" } : {}),
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
    fetch(`/v1/sessions/${sessionId}/events/stream`, {
      headers: { "x-api-key": apiKey },
      signal,
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
