/**
 * Legacy @cloudflare/sandbox outbound shim — no-op stubs.
 *
 * The SDK looks for top-level `outbound` and `outboundByHost` exports as a
 * fallback path before falling back to per-class `outboundHandlers` static
 * methods. We use the per-class path now (apps/agent/src/oma-sandbox.ts
 * registers `inject_vault_creds` via the OmaSandbox class), so these
 * top-level functions never need to do anything — they exist only to
 * satisfy the SDK's named-export expectation.
 *
 * Pre-refactor this file held a KV-snapshot-based credential injector +
 * an OAuth refresh path on 401. Both depended on a per-session KV blob
 * containing plaintext vault credentials in the agent worker scope —
 * which violated the "credentials never leave the main worker" property
 * Anthropic Managed Agents establishes. The publish that fed this blob
 * (apps/agent/src/runtime/session-do.ts:801) is gone too. The OAuth
 * refresh chain that was here is captured as TODO in the followup
 * tracker — same RPC pattern, just a `refreshOutboundOauth` method on
 * McpProxyRpc — and not yet ported because no live OAuth flow uses it
 * in the current OMA surface.
 */

/** Always returns null — never intercept. The active outbound interception
 *  happens in OmaSandbox.outboundHandlers.inject_vault_creds, registered
 *  per-session by SessionDO via setOutboundContext. */
export async function outboundByHost(): Promise<string | null> {
  return null;
}

/** Pass-through fetch — kept only so the SDK's legacy-export probe finds
 *  the symbol. The per-class handler is what actually runs. */
export async function outbound(request: Request): Promise<Response> {
  return fetch(request);
}
