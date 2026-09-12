import type { SessionStreamHandle } from "@open-managed-agents/session-runtime";

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export function createSseStream(
  handle: SessionStreamHandle,
  options: { heartbeatIntervalMs?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const closeHandle = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    options.signal?.removeEventListener("abort", closeHandle);
    if (closed) return;
    closed = true;
    handle.close();
  };

  const safeEnqueue = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunk: string,
  ) => {
    if (closed) return false;
    try {
      controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      closeHandle();
      return false;
    }
  };

  options.signal?.addEventListener("abort", closeHandle, { once: true });
  if (options.signal?.aborted) closeHandle();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      heartbeat = setInterval(() => {
        safeEnqueue(controller, ": keepalive\n\n");
      }, heartbeatIntervalMs);

      try {
        if (!safeEnqueue(controller, "retry: 1000\n\n")) return;
        for await (const frame of handle) {
          let seq: number | undefined;
          let eventType: string | undefined;
          try {
            const parsed = JSON.parse(frame.data) as { seq?: number; type?: string };
            seq = parsed.seq;
            eventType = parsed.type;
          } catch {
            // Preserve opaque frames; only optional SSE metadata is omitted.
          }

          const eventLine = eventType ? `event: ${eventType}\n` : "";
          const idLine = seq !== undefined ? `id: ${seq}\n` : "";
          if (!safeEnqueue(controller, `${eventLine}${idLine}data: ${frame.data}\n\n`)) return;
        }
      } finally {
        closeHandle();
        try {
          controller.close();
        } catch {
          // The downstream reader may already have cancelled the stream.
        }
      }
    },
    cancel() {
      closeHandle();
    },
  });
}
