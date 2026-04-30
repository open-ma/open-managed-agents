/**
 * AcpProxyHarness — HarnessInterface implementation that delegates the agent
 * loop to a Claude Code (or other ACP-compatible) child running on a user's
 * registered local runtime.
 *
 * Per-turn flow:
 *   1. Open a WebSocket directly to the RuntimeRoom DO via the cross-script
 *      binding (env.RUNTIME_ROOM). The DO class lives in the main worker but
 *      DOs are namespace-level, so the agent worker binds the same class with
 *      `script_name: "managed-agents"` in wrangler.jsonc — no service-binding
 *      hop through main, no shared INTEGRATIONS_INTERNAL_SECRET. The DO holds
 *      the WS open and shuttles session.* messages to/from the daemon.
 *   2. Send `session.start` (idempotent on the daemon — first time spawns the
 *      ACP child, subsequent times short-circuits to session.ready).
 *   3. Send `session.prompt { text, turn_id }` with the latest user message.
 *   4. Drain `session.event` notifications via AcpTranslator → SessionEvent
 *      broadcast through the runtime.
 *   5. Resolve when `session.complete` arrives, error on `session.error` or
 *      WS close. Honor `runtime.abortSignal` by sending `session.cancel`.
 *
 * Optional ports / no-op surface (Meta-harness fit):
 *   - `onSessionInit`: no-op. System prompt + skills land on the user's
 *     filesystem as AGENTS.md / `.claude/skills/...` via the daemon's bundle
 *     fetch — they don't enter the events stream.
 *   - `shouldCompact` / `compact` / `deriveModelContext`: ACP agents own their
 *     own context; OMA doesn't drive a generateText call here. All return
 *     false / no-op.
 */

import type { HarnessInterface, HarnessContext, HarnessRuntime } from "./interface";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { AcpTranslator } from "./acp-translate";
import { generateEventId, log, logError, logWarn } from "@open-managed-agents/shared";

interface AttachedWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "message" | "close" | "error",
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
}

export class AcpProxyHarness implements HarnessInterface {
  // No platform reminders for ACP path — the spawn-cwd AGENTS.md handles it.
  async onSessionInit(): Promise<void> {
    /* no-op */
  }

  shouldCompact(): boolean {
    return false; // ACP agent manages its own context window
  }

  async compact(): Promise<void> {
    /* no-op */
  }

  deriveModelContext(): never[] {
    return []; // never called — we don't run generateText
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    const binding = ctx.agent.runtime_binding;
    if (!binding) {
      this.#emitError(runtime, "AcpProxyHarness requires agent.runtime_binding to be set");
      return;
    }

    const env = ctx.env as unknown as { RUNTIME_ROOM?: DurableObjectNamespace };
    if (!env.RUNTIME_ROOM) {
      this.#emitError(runtime, "RUNTIME_ROOM binding missing on agent worker — check wrangler.jsonc cross-script DO binding");
      return;
    }

    const sid = ctx.session_id ?? "";
    if (!sid) {
      this.#emitError(runtime, "AcpProxyHarness needs ctx.session_id but it was not set");
      return;
    }

    const userText = extractUserText(ctx.userMessage);
    if (!userText) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    const ws = await this.#openHarnessWs(env.RUNTIME_ROOM, sid, binding.runtime_id);
    if (!ws) {
      this.#emitError(runtime, "Failed to attach to RuntimeRoom — runtime_id may be invalid or daemon offline");
      return;
    }

    const turnId = generateEventId();
    const translator = new AcpTranslator(runtime);
    const abortHandler = () => {
      try { ws.send(JSON.stringify({ type: "session.cancel", turn_id: turnId })); } catch { /* ws may be dead */ }
    };
    runtime.abortSignal?.addEventListener("abort", abortHandler);

    try {
      // Wait for the DO's "attached" handshake (synthetic, daemon may also
      // have replayed session.ready). After that the daemon is ready to
      // receive session.start / session.prompt.
      await waitForFrame(ws, (m) => m.type === "attached", 5_000);

      // Idempotent session.start — daemon spawns ACP child on first call,
      // short-circuits to session.ready on subsequent calls for the same sid.
      ws.send(JSON.stringify({
        type: "session.start",
        agent_id: binding.acp_agent_id,
      }));
      await waitForFrame(ws, (m) => m.type === "session.ready" || m.type === "session.error", 60_000)
        .then((m) => {
          if (m.type === "session.error") throw new Error(`session.start failed: ${m.message ?? "unknown"}`);
        });

      ws.send(JSON.stringify({
        type: "session.prompt",
        turn_id: turnId,
        text: userText,
      }));

      // Drain until session.complete or session.error or close.
      await new Promise<void>((resolve, reject) => {
        const onMessage = (ev: MessageEvent | CloseEvent | Event) => {
          const data = (ev as MessageEvent).data;
          if (typeof data !== "string") return;
          let parsed: { type?: string; turn_id?: string; message?: string; event?: unknown };
          try { parsed = JSON.parse(data); } catch { return; }

          if (parsed.type === "session.event" && parsed.turn_id === turnId) {
            void translator.consume(parsed as never);
          } else if (parsed.type === "session.complete" && parsed.turn_id === turnId) {
            resolve();
          } else if (parsed.type === "session.error") {
            reject(new Error(parsed.message ?? "session.error from runtime"));
          }
        };
        const onClose = () => reject(new Error("WS to RuntimeRoom closed before turn complete"));
        const onError = () => reject(new Error("WS error to RuntimeRoom"));
        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);
      });

      await translator.flush("completed");
    } catch (err) {
      const aborted = runtime.abortSignal?.aborted ?? false;
      await translator.flush(aborted ? "aborted" : "completed");
      const msg = err instanceof Error ? err.message : String(err);
      if (aborted) {
        log({ op: "acp_proxy.aborted", session_id: sid }, "user-aborted");
      } else {
        logError({ op: "acp_proxy.turn_failed", session_id: sid, err: msg }, "turn failed");
        this.#emitError(runtime, msg);
      }
    } finally {
      runtime.abortSignal?.removeEventListener("abort", abortHandler);
      try { ws.close(1000, "turn done"); } catch { /* already closed */ }
    }
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }

  async #openHarnessWs(
    runtimeRoom: DurableObjectNamespace,
    sid: string,
    runtimeId: string,
  ): Promise<AttachedWs | null> {
    // Direct DO access. The DO class lives in the main worker but DOs are
    // namespace-scoped; the cross-script binding in wrangler.jsonc lets the
    // agent worker hold a stub without going through main as a service.
    // Headers (`x-attach-role`, `x-session-id`) match what the now-removed
    // /v1/internal/runtime-attach-harness endpoint used to inject — DO's
    // fetch handler already keys off them.
    try {
      const stub = runtimeRoom.get(runtimeRoom.idFromName(runtimeId));
      const res = await stub.fetch(
        new Request("http://runtime-room/_attach_harness", {
          headers: {
            Upgrade: "websocket",
            "x-attach-role": "harness",
            "x-session-id": sid,
          },
        }),
      );
      if (res.status !== 101 || !res.webSocket) {
        logWarn(
          { op: "acp_proxy.attach_failed", status: res.status, sid, runtime_id: runtimeId },
          "harness WS attach didn't upgrade",
        );
        return null;
      }
      res.webSocket.accept();
      return res.webSocket as unknown as AttachedWs;
    } catch (e) {
      logError({ op: "acp_proxy.attach_throw", err: String(e), sid }, "harness WS attach threw");
      return null;
    }
  }
}

function extractUserText(msg: UserMessageEvent): string {
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

interface ParsedFrame {
  type?: string;
  message?: string;
  [k: string]: unknown;
}

/** Wait for a single WS frame matching the predicate, with timeout. */
function waitForFrame(
  ws: AttachedWs,
  pred: (msg: ParsedFrame) => boolean,
  timeoutMs: number,
): Promise<ParsedFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for matching frame (${timeoutMs}ms)`));
    }, timeoutMs);
    const onMessage = (ev: MessageEvent | CloseEvent | Event) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== "string") return;
      let parsed: ParsedFrame;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!pred(parsed)) return;
      clearTimeout(timer);
      resolve(parsed);
    };
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error("WS closed while waiting for frame"));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}
