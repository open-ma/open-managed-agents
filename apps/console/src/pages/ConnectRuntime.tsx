import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";
import { Logo } from "../components/Logo";

/** Browser-side handler for `oma bridge setup`. The CLI binds a random
 *  127.0.0.1 port and opens this URL with `?cb=http://127.0.0.1:<port>/cb&state=<nonce>`.
 *  The user authenticates (cookie session), POSTs /v1/runtimes/connect-runtime
 *  to mint a one-time exchange code, then this page redirects back to the
 *  CLI's loopback listener with `?code=...&state=...`. The CLI exchanges
 *  the code at /agents/runtime/exchange for a permanent runtime token.
 *
 *  Mirror of CliLogin.tsx — same shape, different mint endpoint, just one
 *  code per setup (no per-tenant fan-out — the token belongs to the active
 *  tenant at code-mint time). */

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

function isLoopback(callbackUrl: string): boolean {
  try {
    const u = new URL(callbackUrl);
    if (u.protocol !== "http:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function ConnectRuntime() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("cb") ?? "";
  const state = params.get("state") ?? "";
  const callbackOk = isLoopback(callback);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!callbackOk) {
      setError(
        "Invalid callback URL — only loopback addresses (127.0.0.1, localhost) are permitted.",
      );
      setLoading(false);
      return;
    }
    if (!state || state.length < 8) {
      setError("Missing or invalid state parameter — re-run `oma bridge setup`.");
      setLoading(false);
      return;
    }
    api<MeResponse>("/v1/me")
      .then(setMe)
      .catch((err) => {
        if (/401|Unauthorized/i.test(String(err?.message))) {
          setAuthNeeded(true);
        } else {
          setError(String(err?.message ?? err));
        }
      })
      .finally(() => setLoading(false));
  }, [api, callbackOk, state]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const approve = async () => {
    if (!me) return;
    setWorking(true);
    setError("");
    try {
      const { code } = await api<{ code: string; expires_at: number }>(
        "/v1/runtimes/connect-runtime",
        {
          method: "POST",
          body: JSON.stringify({ state }),
        },
      );
      const url = new URL(callback);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  const cancel = () => {
    if (callbackOk) {
      const url = new URL(callback);
      url.searchParams.set("error", "user_cancelled");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } else {
      window.location.href = "/";
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-xl p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <Logo size="md" />
          <div>
            <h1 className="font-display text-lg font-semibold">Connect machine</h1>
            <div className="text-xs text-fg-subtle">openma local runtime</div>
          </div>
        </div>

        {loading && <div className="text-sm text-fg-subtle">Checking session…</div>}

        {!loading && error && (
          <div className="bg-danger-subtle border border-danger/30 text-danger text-sm rounded-lg px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {!loading && authNeeded && (
          <>
            <p className="text-sm text-fg-muted mb-4">Sign in to authorize this machine.</p>
            <Button onClick={goLogin} className="w-full">
              Sign in
            </Button>
          </>
        )}

        {!loading && !authNeeded && me && callbackOk && (
          <>
            <p className="text-sm text-fg-muted mb-2">
              Allow this machine to attach to OMA as{" "}
              <span className="font-mono text-fg">
                {me.user?.email ?? me.user?.id ?? "this user"}
              </span>{" "}
              in workspace <span className="font-mono text-fg">{me.tenant.name}</span>?
            </p>
            <p className="text-xs text-fg-subtle mb-5">
              The daemon will spawn ACP-compatible agents (Claude Code, Codex, etc.) on
              this machine when you bind an agent to it. Revoke any time on the
              Local Runtimes page.
            </p>

            <div className="flex gap-2">
              <Button onClick={approve} disabled={working} className="flex-1">
                {working ? "Authorizing…" : "Allow"}
              </Button>
              <button
                onClick={cancel}
                disabled={working}
                className="inline-flex items-center justify-center px-4 py-2.5 min-h-11 sm:min-h-0 rounded-lg border border-border text-sm text-fg-muted hover:bg-bg disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
