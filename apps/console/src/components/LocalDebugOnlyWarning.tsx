import type { HTMLAttributes } from "react";

/**
 * Security boundary for subscription-backed model credentials.
 *
 * A Codex/ChatGPT subscription credential is intentionally only supported by
 * a trusted local direct-host during development. Remote and managed
 * sandboxes must receive an approved model-gateway credential instead; this
 * component keeps that boundary visible anywhere a user can connect or
 * configure a runtime.
 */
export function LocalDebugOnlyWarning({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="note"
      aria-label="Local debugging only"
      className={`rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-xs text-warning ${className}`.trim()}
      {...props}
    >
      <div className="font-medium">Local debugging only — high risk</div>
      <p className="mt-1 leading-relaxed text-fg-muted">
        Codex/ChatGPT subscription login stays on this trusted host. Never copy
        <code className="mx-1 rounded bg-bg px-1 py-0.5 font-mono text-[11px]">~/.codex/auth.json</code>
        or OAuth tokens into a sandbox. Remote or managed sandboxes must use an
        approved API key or provider OAuth through the OMA model gateway.
      </p>
      <p className="mt-1 leading-relaxed text-fg-muted">
        Subscription credentials are not a production integration: provider terms,
        rate limits, or security checks may restrict or suspend the account. Keep
        this direct-host path for local debugging only.
      </p>
    </div>
  );
}
