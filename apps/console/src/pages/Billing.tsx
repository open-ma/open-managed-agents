import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { useToast } from "../components/Toast";
import { Button } from "../components/Button";

interface SubscriptionRow {
  id: string;
  tier: "free" | "pro" | "max" | string;
  status: string;
  monthly_credit_cents: number;
  bonus_pct: number;
  current_period_start: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
}

interface Summary {
  balance_cents: number;
  subscription: SubscriptionRow | null;
}

interface CheckoutResponse {
  checkout_url: string;
  checkout_id: string;
  status: string;
}

const TOPUP_OPTIONS = [
  { cents: 500,   label: "$5"   },
  { cents: 2000,  label: "$20"  },
  { cents: 5000,  label: "$50"  },
  { cents: 10000, label: "$100" },
];

const SUBSCRIPTION_TIERS: Array<{
  tier: "pro" | "max";
  name: string;
  priceCents: number;
  creditCents: number;
  bonusPct: number;
}> = [
  { tier: "pro", name: "Pro", priceCents: 2000,  creditCents: 2200,  bonusPct: 10 },
  { tier: "max", name: "Max", priceCents: 10000, creditCents: 12000, bonusPct: 20 },
];

function formatCents(cents: number): string {
  if (cents === 0) return "$0.00";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const c = abs % 100;
  return `${sign}$${dollars}.${c.toString().padStart(2, "0")}`;
}

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString();
}

export function Billing() {
  const { api } = useApi();
  const { toast } = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api<Summary>("/v1/billing/summary");
      setSummary(r);
      setUnavailable(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("501") || msg.includes("Billing not configured")) {
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [api]);

  const startCheckout = async (
    body: Record<string, unknown>,
  ) => {
    try {
      const r = await api<CheckoutResponse>("/v1/billing/checkout", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          success_url: `${window.location.origin}/billing?checkout=success`,
        }),
      });
      window.location.href = r.checkout_url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "checkout failed";
      toast(msg, "error");
    }
  };

  if (loading && !summary) {
    return <div className="p-8 text-fg-muted">Loading…</div>;
  }

  if (unavailable) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-xl font-semibold mb-3">Billing</h1>
        <div className="border border-border rounded-md p-4 bg-bg">
          <p className="text-sm text-fg-muted">
            Billing isn't configured for this deployment. If you're self-hosting,
            you can still see your sandbox usage on the{" "}
            <a href="/usage" className="text-brand hover:underline">Usage</a> page —
            it lines up with your Cloudflare Containers bill.
          </p>
        </div>
      </div>
    );
  }

  const balanceCents = summary?.balance_cents ?? 0;
  const sub = summary?.subscription ?? null;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 md:p-8 lg:p-10">
      <div className="max-w-3xl flex flex-col gap-6">
        <div>
          <h1 className="font-display text-lg md:text-xl font-semibold tracking-tight text-fg">Billing</h1>
          <div className="text-sm text-fg-muted mt-0.5">
            Wallet balance, monthly subscription, and one-off top-ups. Cloud
            sandbox runs deduct from your balance at $0.005/min; localRuntime
            is free.
          </div>
        </div>

        {/* Balance card */}
        <div className="border border-border rounded-md p-5 bg-bg">
          <div className="text-xs text-fg-muted uppercase tracking-wider">Balance</div>
          <div className="text-3xl font-semibold mt-1 font-mono">{formatCents(balanceCents)}</div>
          <div className="text-xs text-fg-subtle mt-1">
            {balanceCents <= 0
              ? "Cloud sandbox launches will be refused until balance is positive."
              : `≈ ${Math.floor(balanceCents / 0.5)} sandbox minutes available`}
          </div>
        </div>

        {/* Subscription card */}
        <div className="border border-border rounded-md p-5 bg-bg">
          <div className="text-xs text-fg-muted uppercase tracking-wider mb-2">Subscription</div>
          {sub ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <div className="text-lg font-semibold capitalize">{sub.tier}</div>
                <div className="text-xs text-fg-muted">·</div>
                <div className="text-sm text-fg-muted">{sub.status}</div>
                {sub.cancel_at_period_end ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning">
                    Canceling at period end
                  </span>
                ) : null}
              </div>
              <div className="text-sm text-fg-muted">
                {formatCents(sub.monthly_credit_cents)} credit / month{" "}
                {sub.bonus_pct > 0 && (
                  <span className="text-success">({sub.bonus_pct}% bonus)</span>
                )}
              </div>
              <div className="text-xs text-fg-subtle">
                Period: {formatDate(sub.current_period_start)} → {formatDate(sub.current_period_end)}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-sm text-fg-muted">
                No active subscription. Subscribe for monthly credit + a small bonus,
                or top up manually below.
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {SUBSCRIPTION_TIERS.map((t) => (
                  <div key={t.tier} className="border border-border rounded-md p-4 flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <div className="font-semibold">{t.name}</div>
                      <div className="text-sm font-mono">{formatCents(t.priceCents)}/mo</div>
                    </div>
                    <div className="text-xs text-fg-muted">
                      {formatCents(t.creditCents)} credit each month{" "}
                      <span className="text-success">({t.bonusPct}% bonus)</span>
                    </div>
                    <Button
                      onClick={() => startCheckout({ kind: "subscription", tier: t.tier })}
                    >
                      Subscribe
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Top-up card */}
        <div className="border border-border rounded-md p-5 bg-bg">
          <div className="text-xs text-fg-muted uppercase tracking-wider mb-2">Top up</div>
          <div className="text-sm text-fg-muted mb-3">
            One-off credit. Never expires. Stacks with any subscription credit.
          </div>
          <div className="flex flex-wrap gap-2">
            {TOPUP_OPTIONS.map((o) => (
              <button
                key={o.cents}
                onClick={() => startCheckout({ kind: "topup", amount_cents: o.cents })}
                className="px-4 py-2 border border-border rounded-md text-sm font-medium hover:bg-bg-surface transition-colors"
              >
                Add {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
