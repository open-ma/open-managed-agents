/**
 * Parse a Response body that's `text/event-stream` into an async
 * iterator of JSON-decoded `data:` payloads. Stops when the server
 * closes the connection or the optional AbortSignal fires.
 *
 * Server sends:
 *
 *     data: {"type":"agent.message_chunk","message_id":"...","delta":"..."}
 *
 *     data: {"type":"session.status_idle",...}
 *
 *     <connection closes>
 *
 * Each `data:` block is one JSON value (no multi-line `data:` joining
 * since the server emits one event per block). Yields parsed values;
 * malformed blocks are skipped silently rather than crashing the
 * consumer mid-stream.
 */
export async function* parseSSE<T>(res: Response, signal?: AbortSignal): AsyncIterable<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try { yield JSON.parse(line.slice(6)) as T; }
        catch { /* malformed event — skip without crashing the consumer */ }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
