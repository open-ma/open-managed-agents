const BASE = "";

import { useCallback, useMemo } from "react";
import { useToast } from "../components/Toast";
import { fetchEventSource } from "@microsoft/fetch-event-source";

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

  // `api` and `streamEvents` are wrapped in useCallback with `[toast]` as the
  // sole dep so a render of any consumer doesn't produce a fresh closure.
  // Before this, every component calling `useApi()` got new function identities
  // each render — including them in a `useEffect` dep array would loop the
  // effect, so callers had to either omit `api` (eslint-disable) or stash it
  // in a ref. With these stable refs, `useApiQuery` / `useInfiniteApiQuery` /
  // `useEffect([id])` can include `api` cleanly without retriggering.
  // `toast` itself is stable (Toast.tsx wraps it in useCallback([], [])).
  const api = useCallback(
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
    },
    [toast],
  );

  const streamEvents = useCallback(
    (
      sessionId: string,
      onEvent: (event: Record<string, unknown>) => void,
      signal?: AbortSignal,
    ) => {
      const activeTenant = getActiveTenantId();
      // SSE endpoint goes through the same auth middleware so it needs the
      // header too. fetchEventSource lets us set it; EventSource wouldn't.
      //
      // Console opts into both `chunks` (token-by-token rendering, pending
      // queue events, session.warning, extra spans) and `replay=1` (full
      // history on connect — Console renders the persistent timeline view
      // and the dedup keyset at SessionDetail.tsx:108-121 already handles
      // any seq-overlap from concurrent live broadcasts; replay-on-reconnect
      // is therefore safe — duplicates get dropped before render).
      //
      // Default endpoint behavior is Anthropic-spec — third-party clients
      // using @anthropic-ai/sdk against an OMA server get a clean stream
      // without these flags. See SPEC_EVENT_TYPES in @open-managed-agents/api-types.
      const path = `/v1/sessions/${sessionId}/events/stream?include=chunks&replay=1`;

      // Sentinel error classes per the @microsoft/fetch-event-source README
      // pattern — the lib doesn't export these; consumers define them locally
      // and use instanceof in onerror to choose retry vs. abort.
      class FatalError extends Error {}
      class RetriableError extends Error {}

      // Reconnect schedule for transient failures (network blip, 5xx, EOF).
      // Resets to zero on a successful onopen so a healthy session that
      // briefly drops doesn't keep accumulating backoff. After 5 consecutive
      // failures we surface a single "Reconnecting…" toast — silent before
      // that so a 1-second blip doesn't pop UI noise.
      const backoffMs = [1000, 2000, 4000, 8000];
      let consecutiveFailures = 0;
      let reconnectToastShown = false;

      void fetchEventSource(path, {
        credentials: "include",
        signal,
        // Keep the stream alive when the tab is hidden. Default behavior
        // closes on visibilitychange and reopens on focus, which forces an
        // unwanted full replay every time the user tabs away from a long
        // session. The original fetch() impl had no visibility handling, so
        // this preserves that behavior.
        openWhenHidden: true,
        headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
        async onopen(response) {
          if (response.ok) {
            // Connection (re)established — clear the failure counter so the
            // next drop starts a fresh backoff schedule, and clear the toast
            // sentinel so a future degraded period can re-notify the user.
            consecutiveFailures = 0;
            reconnectToastShown = false;
            return;
          }
          if (response.status >= 400) {
            // Surface stream open failures the same way as regular API calls —
            // previously a 401 / 500 on the SSE handshake meant the timeline
            // just never updated. 4xx and 5xx alike get the same toast format
            // so the user sees a real error message instead of silence.
            const body = await response.json().catch(() => ({}));
            const message = readApiErrorMessage(body, response.status);
            toast(`/v1/sessions/${sessionId}/events/stream: ${message}`, "error");
            // Non-retriable: 401/403/404 won't fix themselves on retry, and
            // hammering a 5xx that's surfaced to the user is also pointless.
            // FatalError signals onerror to stop the loop.
            throw new FatalError(message);
          }
          // Anything non-ok that isn't ≥400 (3xx etc.) — let the lib retry.
          throw new RetriableError(`status ${response.status}`);
        },
        onmessage(ev) {
          // Heartbeat / keepalive ping — the server periodically emits empty
          // SSE frames to keep CF from idling the connection. Skip silently.
          if (!ev.data) return;
          try {
            onEvent(JSON.parse(ev.data) as Record<string, unknown>);
          } catch {
            // Malformed payload — silently skip, matches prior behavior.
          }
        },
        onclose() {
          // Server closed the stream cleanly without an abort. Throw to force
          // a reconnect — Cloudflare Workers cap streamed responses at a few
          // minutes, and the user expects the timeline to keep updating across
          // reconnects. Replay=1 + SessionDetail's seenKeys dedup makes the
          // refill safe.
          throw new RetriableError("server closed");
        },
        onerror(err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            // Caller unmounted (component cleanup) — stop retrying. The lib
            // normally short-circuits on the input signal abort before we
            // get here, but defending against the edge case is cheap.
            throw err;
          }
          if (err instanceof FatalError) {
            // 401/403/404/5xx surfaced from onopen — toast already shown,
            // rethrow so the lib stops retrying.
            throw err;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures === 5 && !reconnectToastShown) {
            reconnectToastShown = true;
            toast("Reconnecting…", "info");
          }
          const idx = Math.min(consecutiveFailures - 1, backoffMs.length - 1);
          return backoffMs[idx];
        },
      }).catch(() => {
        // Promise rejects on FatalError or AbortError — both are expected
        // terminal states. FatalError already toasted from onopen; AbortError
        // is caller-initiated cleanup. Nothing more to do.
      });
    },
    [toast],
  );

  return useMemo(() => ({ api, streamEvents }), [api, streamEvents]);
}
