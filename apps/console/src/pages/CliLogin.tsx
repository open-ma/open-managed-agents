import { useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";

// Browser-side handler for `oma auth login`. The CLI opens this URL with
// callback + state in the query string, the user authenticates (cookie
// session) + picks one or more workspaces, and the page redirects back
// to the CLI's loopback server with N freshly-minted per-tenant tokens.
//
// Flow:
//   1. Read query params (callback, state, hostname, tenant?).
//   2. If no cookie session → bounce through /login with `next=` set to here.
//   3. Fetch /v1/me to learn user + memberships.
//   4. Show approval UI: when N==1, just an Approve button; when N>1, a
//      checkbox list (defaults: ?tenant pre-selected, otherwise all).
//   5. POST /v1/me/cli-tokens N times — one token per selected tenant.
//   6. window.location = `${callback}?tokens=<base64-json>&user=...&state=...`
//      — the array form so the CLI can populate every selected tenant's
//      profile in one round trip.
//
// Security notes:
//   - The `state` param is opaque to us; the CLI generates a nonce, stashes
//     it locally, and verifies it on the callback. We just round-trip it.
//   - The `callback` param MUST be a 127.0.0.1 / localhost URL — we reject
//     anything else so a malicious link can't trick a logged-in user into
//     handing tokens to an attacker-controlled host.
//   - One mint failure aborts the whole batch — partial tokens are
//     surfaced as an error, not silently delivered, so the user can see
//     exactly what landed.

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

interface MintedToken {
  tenant_id: string;
  tenant_name: string;
  role: string;
  token: string;
  key_id: string;
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

function tenantDisplayName(t: { id: string; name: string }): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) {
    return t.id;
  }
  return trimmed;
}

/** Browser-safe base64-encode of a UTF-8 JSON string. */
function encodeTokensParam(tokens: MintedToken[]): string {
  const json = JSON.stringify(tokens);
  // Use the binary-safe TextEncoder→btoa pattern; raw btoa() chokes on
  // multibyte characters that may appear in tenant names.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function CliLogin() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("callback") ?? "";
  const state = params.get("state") ?? "";
  const hostname = params.get("hostname") ?? "this device";
  const requestedTenant = params.get("tenant") ?? "";
  const callbackOk = isLoopback(callback);

  const [me, setMe] = useState<MeResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
        // Default selection: respect ?tenant if it's a real membership,
        // otherwise select all (the "authorize CLI for everything" intent
        // most multi-tenant users have on first login).
        const ids = res.tenants.map((t) => t.id);
        if (requestedTenant && ids.includes(requestedTenant)) {
          setSelected(new Set([requestedTenant]));
        } else {
          setSelected(new Set(ids));
        }
      })
      .catch((err) => {
        if (/401|Unauthorized/i.test(String(err?.message))) {
          setAuthNeeded(true);
        } else {
          setError(String(err?.message ?? err));
        }
      })
      .finally(() => setLoading(false));
  }, [api, callbackOk, requestedTenant]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!me) return;
    setSelected(new Set(me.tenants.map((t) => t.id)));
  };

  const selectNone = () => setSelected(new Set());

  const approve = async () => {
    if (selected.size === 0 || !me) return;
    setWorking(true);
    setError("");
    try {
      // Mint per-tenant tokens. Run in parallel — the endpoint is cheap
      // and the user already consented to all selected workspaces.
      const orderedSelection = me.tenants.filter((t) => selected.has(t.id));
      const minted = await Promise.all(
        orderedSelection.map(async (t) => {
          const res = await api<{ token: string; tenant_id: string; user_id: string; key_id: string }>(
            "/v1/me/cli-tokens",
            {
              method: "POST",
              body: JSON.stringify({
                tenant_id: t.id,
                name: `CLI on ${hostname}`,
              }),
              // Force the mint call to operate against THIS tenant — the
              // sidebar's stored localStorage might point elsewhere, and
              // the auth middleware would otherwise mint for the wrong one.
              headers: { "x-active-tenant": t.id },
            },
          );
          return {
            tenant_id: res.tenant_id,
            tenant_name: t.name,
            role: t.role,
            token: res.token,
            key_id: res.key_id,
          } satisfies MintedToken;
        }),
      );
      const url = new URL(callback);
      url.searchParams.set("tokens", encodeTokensParam(minted));
      url.searchParams.set("user", me.user?.id ?? minted[0]?.tenant_id ?? "");
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
          <img src="/logo.svg" alt="openma" className="h-9 shrink-0" />
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
              Approving mints one API key per selected workspace — visible
              on the API Keys page, revocable at any time.
            </p>

            {me.tenants.length === 0 ? (
              <div className="text-sm text-danger mb-4">
                No workspaces found on this account.
              </div>
            ) : me.tenants.length === 1 ? (
              <div className="mb-5">
                <div className="block text-xs uppercase tracking-wider text-fg-subtle mb-2">
                  Workspace
                </div>
                <div className="bg-bg border border-border rounded-lg px-3 py-2.5 text-sm flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-brand/15 text-brand flex items-center justify-center text-xs font-mono font-bold shrink-0">
                    {tenantDisplayName(me.tenants[0]).charAt(0).toUpperCase() || "·"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-fg">{tenantDisplayName(me.tenants[0])}</div>
                    <div className="text-[10px] text-fg-subtle font-mono uppercase tracking-wider">
                      {me.tenants[0].role}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs uppercase tracking-wider text-fg-subtle">
                    Workspaces ({selected.size}/{me.tenants.length})
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-fg-muted hover:text-fg underline-offset-2 hover:underline"
                    >
                      All
                    </button>
                    <span className="text-fg-subtle">·</span>
                    <button
                      type="button"
                      onClick={selectNone}
                      className="text-fg-muted hover:text-fg underline-offset-2 hover:underline"
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="border border-border rounded-lg divide-y divide-border max-h-64 overflow-y-auto">
                  {me.tenants.map((t) => {
                    const isSelected = selected.has(t.id);
                    const display = tenantDisplayName(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggle(t.id)}
                        className={`w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-bg transition-colors ${isSelected ? "bg-bg/60" : ""}`}
                      >
                        <Checkbox checked={isSelected} />
                        <div className="w-7 h-7 rounded bg-brand/15 text-brand flex items-center justify-center text-xs font-mono font-bold shrink-0">
                          {display.charAt(0).toUpperCase() || "·"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate text-fg">{display}</div>
                          <div className="text-[10px] text-fg-subtle font-mono">
                            {t.id} · {t.role}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={approve}
                disabled={working || selected.size === 0 || me.tenants.length === 0}
                className="flex-1"
              >
                {working
                  ? "Authorizing…"
                  : me.tenants.length <= 1
                    ? "Approve"
                    : `Approve ${selected.size} workspace${selected.size === 1 ? "" : "s"}`}
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

/** Custom checkbox styled to match the rest of the app's surfaces — using
 *  a real <input type=checkbox> would inherit the OS-native chrome that
 *  looks out of place on the auth card. */
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div
      className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
        checked ? "bg-brand border-brand" : "bg-bg border-border-strong"
      }`}
    >
      {checked && (
        <svg className="w-3 h-3 text-brand-fg" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  );
}
