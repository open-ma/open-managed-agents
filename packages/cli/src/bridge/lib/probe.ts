/**
 * Server-side validation probe for a runtime token.
 *
 * Hits the same WS attach endpoint the daemon uses, distinguishing three
 * outcomes:
 *
 *   - "ok"          — server is reachable AND recognises the token. Includes
 *                     409 (daemon already attached) — the slot is busy but
 *                     the token + runtime row clearly exist.
 *   - "invalid"     — server returned 401/403/404. The runtime was deleted
 *                     from the console, or the token was revoked, and the
 *                     creds file on disk is stale.
 *   - "unreachable" — network error, DNS fail, timeout, etc. We can't tell
 *                     whether the token is valid; caller decides whether to
 *                     proceed (offline tolerance) or bail.
 *
 * Used by `oma bridge setup` (fast-path) and `oma bridge status`.
 */

export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unreachable"; detail: string };

export async function probeRuntimeToken(
  serverUrl: string,
  token: string,
  timeoutMs = 8000,
): Promise<ProbeResult> {
  const wsUrl = `${serverUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "")}/agents/runtime/_attach`;
  const WebSocket = (await import("ws")).default;

  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      settle({ ok: false, reason: "unreachable", detail: "timeout" });
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timer);
      try { ws.close(1000, "probe"); } catch { /* ignore */ }
      settle({ ok: true });
    });

    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      // 401/403/404 = server forgot us. 409 = busy slot but token is fine.
      if (status === 401 || status === 403 || status === 404) {
        settle({ ok: false, reason: "invalid", detail: `HTTP ${status}` });
      } else {
        settle({ ok: true });
      }
    });

    ws.once("error", (e) => {
      clearTimeout(timer);
      settle({
        ok: false,
        reason: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
      });
    });
  });
}
