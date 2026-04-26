import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";

// Browser-side handler for `oma auth login`. The CLI opens this URL with
// callback + state in the query string, the user authenticates (cookie
// session) + picks a tenant, and the page redirects back to the CLI's
// loopback server with a freshly-minted token.
//
// Flow:
//   1. Read query params (callback, state, hostname).
//   2. If no cookie session → bounce through /login with `next=` set to here.
//   3. Fetch /v1/me to learn user + tenants.
//   4. Show approval UI with tenant picker (forward-compat for multi-tenant;
//      today the picker has exactly one option and is auto-preselected).
//   5. POST /v1/me/cli-tokens → receive { token, tenant_id, ... }.
//   6. window.location = `${callback}?token=...&tenant=...&user=...&state=...`.
//
// Security notes:
//   - The `state` param is opaque to us; the CLI generates a nonce, stashes
//     it locally, and verifies it on the callback. We just round-trip it.
//   - The `callback` param MUST be a 127.0.0.1 / localhost URL — we reject
//     anything else so a malicious link can't trick a logged-in user into
//     handing a token to an attacker-controlled host.

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

export function CliLogin() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("callback") ?? "";
  const state = params.get("state") ?? "";
  const hostname = params.get("hostname") ?? "this device";
  const callbackOk = isLoopback(callback);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [chosenTenant, setChosenTenant] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!callbackOk) {
      setError("Invalid callback URL — only loopback addresses (127.0.0.1, localhost) are permitted.");
      setLoading(false);
      return;
    }
    api<MeResponse>("/v1/me")
      .then((res) => {
        setMe(res);
        if (res.tenants.length > 0) setChosenTenant(res.tenant?.id || res.tenants[0].id);
      })
      .catch((err) => {
        // 401 → not logged in. Bounce through /login with a `next=` param so
        // the user lands back here after authenticating.
        if (/401|Unauthorized/i.test(String(err?.message))) {
          setAuthNeeded(true);
        } else {
          setError(String(err?.message ?? err));
        }
      })
      .finally(() => setLoading(false));
  }, [api, callbackOk]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const approve = async () => {
    if (!chosenTenant) return;
    setWorking(true);
    setError("");
    try {
      const res = await api<{ token: string; tenant_id: string; user_id: string; key_id: string }>(
        "/v1/me/cli-tokens",
        {
          method: "POST",
          body: JSON.stringify({
            tenant_id: chosenTenant,
            name: `CLI on ${hostname}`,
          }),
        },
      );
      const url = new URL(callback);
      url.searchParams.set("token", res.token);
      url.searchParams.set("tenant", res.tenant_id);
      url.searchParams.set("user", res.user_id);
      url.searchParams.set("key_id", res.key_id);
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
      <div className="w-full max-w-md bg-bg-surface border border-border rounded-2xl p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-brand text-brand-fg flex items-center justify-center font-mono text-sm font-bold">
            oma
          </div>
          <div>
            <div className="font-display text-lg font-semibold">Authorize CLI</div>
            <div className="text-xs text-fg-subtle">openma command-line client</div>
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
            <p className="text-sm text-fg-muted mb-4">
              Sign in to continue authorizing the CLI on{" "}
              <span className="font-mono text-fg">{hostname}</span>.
            </p>
            <Button onClick={goLogin} className="w-full">
              Sign in
            </Button>
          </>
        )}

        {!loading && !authNeeded && me && callbackOk && (
          <>
            <p className="text-sm text-fg-muted mb-2">
              The CLI on{" "}
              <span className="font-mono text-fg">{hostname}</span> wants to
              act on your behalf as{" "}
              <span className="font-mono text-fg">{me.user?.email ?? me.user?.id ?? "this user"}</span>.
            </p>
            <p className="text-xs text-fg-subtle mb-5">
              Approving will mint an API key visible on the API Keys page —
              revoke it there at any time.
            </p>

            <label className="block text-xs uppercase tracking-wider text-fg-subtle mb-2">
              Workspace
            </label>
            {me.tenants.length === 0 ? (
              <div className="text-sm text-danger mb-4">
                No workspaces found on this account.
              </div>
            ) : me.tenants.length === 1 ? (
              <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono text-fg-muted mb-5">
                {me.tenants[0].name || me.tenants[0].id}
                <span className="text-fg-subtle ml-2">({me.tenants[0].role})</span>
              </div>
            ) : (
              <select
                value={chosenTenant}
                onChange={(e) => setChosenTenant(e.target.value)}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm font-mono mb-5"
              >
                {me.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name || t.id} ({t.role})
                  </option>
                ))}
              </select>
            )}

            <div className="flex gap-2">
              <Button
                onClick={approve}
                disabled={working || !chosenTenant || me.tenants.length === 0}
                className="flex-1"
              >
                {working ? "Authorizing…" : "Approve"}
              </Button>
              <button
                onClick={cancel}
                disabled={working}
                className="px-4 py-2.5 rounded-lg border border-border text-sm text-fg-muted hover:bg-bg disabled:opacity-40"
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
