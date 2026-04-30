// OMA Sandbox subclass — wires the @cloudflare/sandbox 0.8.x outbound
// handler API so vault credentials get injected into outbound requests
// (e.g. Bearer header for MCP server calls). The handler is bound at
// runtime via `sandbox.setOutboundHandler("inject_vault_creds", { ... })`
// — see apps/agent/src/runtime/session-do.ts for where that fires.
//
// Architectural property (mirrors Anthropic Managed Agents' "credential
// proxy outside the harness" pattern): this handler runs in the agent
// worker process, but it does NOT receive plaintext vault credentials in
// its `ctx.params`. The only data passed in is `(tenantId, sessionId)` —
// public identifiers that the model could already see. The actual
// credential lookup and injection happen in main worker via the
// `env.MAIN_MCP.outboundForward` WorkerEntrypoint RPC, where the vault
// data already lives.
//
// Pre-refactor we passed `vault_credentials` directly to setOutboundHandler;
// CF Sandbox SDK then stashed them in container memory. A
// container-escape or prompt-injection-driven RCE could read them out.
// Post-refactor: the agent worker's address space never contains the
// credentials at all. Container compromise can't exfiltrate what the
// container's host process never loaded.
//
// API reference: https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/

import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "@open-managed-agents/shared";

// Match the SDK's OutboundHandlerContext shape (see @cloudflare/containers).
// We accept `unknown` env + cast at the boundary, so we don't need a direct
// import of the SDK's internal types.
interface SdkContext<P = unknown> {
  containerId: string;
  className: string;
  params: P;
}

interface OutboundContextParams {
  tenantId?: string;
  sessionId?: string;
}

const injectVaultCredsHandler = async (
  request: Request,
  env: unknown,
  ctx: SdkContext<OutboundContextParams>,
): Promise<Response> => {
  const url = new URL(request.url);
  const params = ctx.params ?? {};
  const e = env as Env;

  // Wiring missing — refuse the call (fail-closed). If we returned
  // `fetch(request)` here we'd silently send the request without the
  // credential injection the caller relied on; for an MCP-style
  // upstream that returns 200-with-empty for unauthenticated
  // requests, the model would see "the tool worked, no data" and
  // never know auth was missing. Returning 503 makes the failure
  // visible to the model immediately.
  if (!params.tenantId || !params.sessionId || !e.MAIN_MCP) {
    console.error(
      `[oma-sandbox] inject_vault_creds fail-closed host=${url.hostname} reason=no-context`,
    );
    return new Response(
      JSON.stringify({
        error: "outbound_credential_injection_unavailable",
        reason: "session context not bound — sandbox warmup likely incomplete",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // Body capture: the SDK gives us a Request; we have to read the body
  // before forwarding via RPC because the RPC method signature takes a
  // string, not a stream. For typical sandbox HTTPS calls (JSON API
  // requests to Linear / GitHub / Slack) this is fine. For large binary
  // uploads we'd need to widen the RPC body type — leave that for when
  // a real use case lands.
  const method = request.method;
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let body: string | null;
  try {
    body =
      method === "GET" || method === "HEAD" ? null : await request.text();
  } catch (err) {
    console.error(
      `[oma-sandbox] inject_vault_creds body-read fail host=${url.hostname}: ${(err as Error)?.message ?? err}`,
    );
    return new Response(
      JSON.stringify({
        error: "outbound_body_read_failed",
        reason: (err as Error)?.message ?? "unknown",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  let result: { status: number; headers: Record<string, string>; body: string };
  try {
    result = await e.MAIN_MCP.outboundForward({
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      url: request.url,
      method,
      headers,
      body,
    });
  } catch (err) {
    // Service-binding RPC threw — main worker unreachable, deploy in
    // progress, etc. Fail-closed: don't fall back to direct fetch
    // (which would skip credential injection silently). The model sees
    // 502 and surfaces the failure to the user.
    console.error(
      `[oma-sandbox] inject_vault_creds fail-closed host=${url.hostname} reason=rpc-error: ${(err as Error)?.message ?? err}`,
    );
    return new Response(
      JSON.stringify({
        error: "outbound_credential_injection_failed",
        reason: (err as Error)?.message ?? "main worker RPC unreachable",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  console.log(
    `[oma-sandbox] inject_vault_creds host=${url.hostname} status=${result.status}`,
  );

  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
};

export class OmaSandbox extends Sandbox {
  // Default in @cloudflare/containers is `interceptHttps = false`, which means
  // HTTPS requests bypass the outbound handler entirely. Linear MCP and most
  // other targets are HTTPS, so we must opt in for credential injection to
  // happen. The SDK creates a per-instance ephemeral CA and trusts it inside
  // the container automatically.
  override interceptHttps = true;
}

// Assign via the inherited static setter (Sandbox/Container expose
// outboundHandlers as a get/set accessor, not a plain field — class field
// syntax `static outboundHandlers = {...}` would shadow without triggering
// the setter, leaving the SDK unable to find the handler at runtime).
(OmaSandbox as unknown as {
  outboundHandlers: Record<string, typeof injectVaultCredsHandler>;
}).outboundHandlers = {
  inject_vault_creds: injectVaultCredsHandler,
};
