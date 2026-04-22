// OMA Sandbox subclass — wires the @cloudflare/sandbox 0.8.x outbound
// handler API so vault credentials get injected into outbound requests
// (e.g. Bearer header for MCP server calls). The handler is bound at
// runtime via `sandbox.setOutboundHandler("inject_vault_creds", { ... })`
// — see apps/agent/src/runtime/session-do.ts for where that fires.
//
// API reference: https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/

import { Sandbox } from "@cloudflare/sandbox";

// Match the SDK's OutboundHandlerContext shape (see @cloudflare/containers).
// We accept `unknown` env + cast params, so we don't need a direct import.
interface SdkContext<P = unknown> {
  containerId: string;
  className: string;
  params: P;
}

interface InjectParams {
  vault_credentials?: Array<{
    vault_id: string;
    credentials: Array<{
      id: string;
      auth?: {
        type: string;
        mcp_server_url?: string;
        token?: string;
        access_token?: string;
      };
    }>;
  }>;
}

function pickAuthHeader(
  hostname: string,
  vaultCreds: InjectParams["vault_credentials"],
): string | null {
  if (!vaultCreds) return null;
  for (const v of vaultCreds) {
    for (const cred of v.credentials) {
      if (!cred.auth?.mcp_server_url) continue;
      try {
        const credUrl = new URL(cred.auth.mcp_server_url);
        if (credUrl.hostname !== hostname) continue;
        if (cred.auth.type === "static_bearer" && cred.auth.token) {
          return `Bearer ${cred.auth.token}`;
        }
        if (cred.auth.type === "mcp_oauth" && cred.auth.access_token) {
          return `Bearer ${cred.auth.access_token}`;
        }
      } catch {
        // skip malformed url
      }
    }
  }
  return null;
}

const injectVaultCredsHandler = async (
  request: Request,
  _env: unknown,
  ctx: SdkContext<InjectParams>,
): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const params = ctx.params ?? {};
    const credCount = (params.vault_credentials ?? []).reduce(
      (n, v) => n + v.credentials.length,
      0,
    );
    console.log(
      `[oma-sandbox] inject_vault_creds host=${url.hostname} containerId=${ctx.containerId} creds=${credCount}`,
    );
    const auth = pickAuthHeader(url.hostname, params.vault_credentials);
    console.log(`[oma-sandbox] inject_vault_creds matched=${!!auth}`);
    if (!auth) return fetch(request);
    const headers = new Headers(request.headers);
    headers.set("Authorization", auth);
    return fetch(new Request(request, { headers }));
  } catch (err) {
    console.error(`[oma-sandbox] inject_vault_creds error: ${(err as Error)?.message ?? err}`);
    return fetch(request);
  }
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

