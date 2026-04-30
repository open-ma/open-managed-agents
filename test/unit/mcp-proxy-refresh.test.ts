// @ts-nocheck
// Unit tests for the OAuth refresh path inside `forwardWithRefresh`
// (apps/main/src/routes/mcp-proxy.ts). The full flow — sandbox →
// outbound interceptor → service binding RPC → upstream MCP server with
// expired token → refresh — needs a real OAuth provider to exercise end
// to end, which we can't reasonably set up on staging without burning
// real credentials. These tests instead drive `forwardWithRefresh`
// directly with mocked fetch + an in-memory CredentialService, covering
// the three production-relevant code paths:
//
//   1. Happy path with no 401: forwardToUpstream, no refresh, no D1
//      writes.
//   2. 401 → refresh → retry: token_endpoint hit once, D1 row updated
//      via services.credentials.refreshAuth, retry uses the new token.
//   3. 401 + concurrent refresh dedup: a second forwardWithRefresh that
//      starts AFTER another in-flight refresh persisted the new token
//      should re-fetch the credential, see the live access_token has
//      moved, and skip the token_endpoint roundtrip entirely.
//
// What this proves: the wire-level mechanics of refresh + dedup work
// correctly. What it does NOT prove: that real OAuth providers (Linear /
// Notion / etc) actually return the response shape our parser expects,
// or that the session-binding RPC layer plumbs everything through. Both
// of those are tested at staging-deploy regression level.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { forwardWithRefresh } from "../../apps/main/src/routes/mcp-proxy";
import { createInMemoryCredentialService } from "../../packages/credentials-store/src/test-fakes";
import type { CredentialService } from "../../packages/credentials-store/src/service";
import type { Services } from "../../packages/services/src/index";

const TENANT = "tn_test";
const VAULT = "vlt_test";
const SERVER = "https://upstream.example/mcp";
const TOKEN_EP = "https://upstream.example/oauth/token";

function makeServices(): { services: Services; credService: CredentialService } {
  const { service: credService } = createInMemoryCredentialService();
  const services = { credentials: credService } as unknown as Services;
  return { services, credService };
}

async function seedCred(credService: CredentialService, accessToken: string) {
  return credService.create({
    tenantId: TENANT,
    vaultId: VAULT,
    displayName: "test cred",
    auth: {
      type: "mcp_oauth",
      mcp_server_url: SERVER,
      access_token: accessToken,
      refresh_token: "refresh_v1",
      token_endpoint: TOKEN_EP,
      client_id: "test-client",
    } as never,
  });
}

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
  headers: Headers;
}

/** Mock global fetch with a queue of programmable responders.
 *  Each call records what was sent + invokes the matching handler. */
function installFetchMock(
  handlers: Array<(call: FetchCall) => Response | Promise<Response>>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as never, init);
    const body = ["GET", "HEAD"].includes(req.method) ? null : await req.text();
    const call: FetchCall = {
      url: req.url,
      method: req.method,
      body,
      headers: req.headers,
    };
    calls.push(call);
    const handler = handlers[i] ?? handlers[handlers.length - 1];
    i += 1;
    return handler(call);
  }) as never;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("forwardWithRefresh — OAuth refresh on 401", () => {
  let mock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    mock = installFetchMock([]);
  });

  afterEach(() => {
    mock.restore();
  });

  it("happy path: no 401 → no refresh, no D1 writes", async () => {
    const { services, credService } = makeServices();
    const cred = await seedCred(credService, "stale-but-valid");

    mock.restore();
    mock = installFetchMock([
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);

    const target = {
      upstreamUrl: SERVER,
      upstreamToken: "stale-but-valid",
      refresh: {
        refreshToken: "refresh_v1",
        tokenEndpoint: TOKEN_EP,
        clientId: "test-client",
        credentialId: cred.id,
        vaultId: VAULT,
      },
    };

    const res = await forwardWithRefresh(
      services,
      TENANT,
      target,
      "POST",
      new Headers({ "content-type": "application/json" }),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe(SERVER);
    expect(mock.calls[0].headers.get("authorization")).toBe("Bearer stale-but-valid");
    // No D1 write since no refresh happened.
    const live = await credService.get({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    expect((live!.auth as { access_token: string }).access_token).toBe("stale-but-valid");
  });

  it("401 → refresh succeeds → retry with fresh token → 200 + D1 updated", async () => {
    const { services, credService } = makeServices();
    const cred = await seedCred(credService, "expired-token");

    mock.restore();
    mock = installFetchMock([
      // 1. Upstream POST → 401
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      // 2. token_endpoint POST → fresh tokens
      () =>
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh_v2",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      // 3. Upstream retry → 200
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);

    const target = {
      upstreamUrl: SERVER,
      upstreamToken: "expired-token",
      refresh: {
        refreshToken: "refresh_v1",
        tokenEndpoint: TOKEN_EP,
        clientId: "test-client",
        credentialId: cred.id,
        vaultId: VAULT,
      },
    };

    const res = await forwardWithRefresh(
      services,
      TENANT,
      target,
      "POST",
      new Headers({ "content-type": "application/json" }),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      { sessionId: "sess_test", serverName: "test", callerKind: "rpc-mcp" },
    );

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(3);
    // Call 1: upstream w/ stale token
    expect(mock.calls[0].url).toBe(SERVER);
    expect(mock.calls[0].headers.get("authorization")).toBe("Bearer expired-token");
    // Call 2: token_endpoint refresh
    expect(mock.calls[1].url).toBe(TOKEN_EP);
    expect(mock.calls[1].method).toBe("POST");
    expect(mock.calls[1].body).toContain("grant_type=refresh_token");
    expect(mock.calls[1].body).toContain("refresh_token=refresh_v1");
    // Call 3: upstream retry w/ fresh token
    expect(mock.calls[2].url).toBe(SERVER);
    expect(mock.calls[2].headers.get("authorization")).toBe("Bearer fresh-access");

    // D1 row updated
    const live = await credService.get({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    expect((live!.auth as { access_token: string }).access_token).toBe("fresh-access");
    expect((live!.auth as { refresh_token: string }).refresh_token).toBe("refresh_v2");
  });

  it("dedup: second 401 sees already-refreshed credential in D1, skips token_endpoint", async () => {
    const { services, credService } = makeServices();
    const cred = await seedCred(credService, "expired-token");

    // Simulate that ANOTHER concurrent call already refreshed the
    // credential before we got here (rotated access_token in D1).
    await credService.refreshAuth({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
      auth: { access_token: "fresh-from-other-call" },
    });

    mock.restore();
    mock = installFetchMock([
      // 1. Upstream POST w/ stale → 401 (we still had old token in target)
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      // 2. Upstream retry w/ fresh-from-other-call → 200
      // NOTE: NO token_endpoint call between, because dedup short-
      // circuits when D1 has a different (newer) access_token.
      () =>
        new Response('{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ]);

    const target = {
      upstreamUrl: SERVER,
      upstreamToken: "expired-token", // stale, mirrors what the caller carried in
      refresh: {
        refreshToken: "refresh_v1",
        tokenEndpoint: TOKEN_EP,
        clientId: "test-client",
        credentialId: cred.id,
        vaultId: VAULT,
      },
    };

    const res = await forwardWithRefresh(
      services,
      TENANT,
      target,
      "POST",
      new Headers({ "content-type": "application/json" }),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );

    expect(res.status).toBe(200);
    // Critical: only 2 fetch calls — upstream 401 + upstream retry.
    // No token_endpoint hit. The dedup avoided burning a refresh_token.
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].url).toBe(SERVER);
    expect(mock.calls[1].url).toBe(SERVER);
    expect(mock.calls[1].headers.get("authorization")).toBe("Bearer fresh-from-other-call");
  });

  it("refresh fails (token_endpoint 400) → second upstream call, surfaces original 401", async () => {
    const { services, credService } = makeServices();
    const cred = await seedCred(credService, "expired-token");

    mock.restore();
    mock = installFetchMock([
      // 1. Upstream → 401
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      // 2. token_endpoint → 400 (refresh_token revoked, scope removed, etc.)
      () =>
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      // 3. Upstream retry w/ original (still-stale) token → 401 again
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]);

    const target = {
      upstreamUrl: SERVER,
      upstreamToken: "expired-token",
      refresh: {
        refreshToken: "refresh_v1",
        tokenEndpoint: TOKEN_EP,
        clientId: "test-client",
        credentialId: cred.id,
        vaultId: VAULT,
      },
    };

    const res = await forwardWithRefresh(
      services,
      TENANT,
      target,
      "POST",
      new Headers({ "content-type": "application/json" }),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );

    // Caller gets the upstream's actual 401 — not a misleading
    // "everything's fine" empty success.
    expect(res.status).toBe(401);
    // D1 unchanged — refresh failure doesn't corrupt the row.
    const live = await credService.get({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    expect((live!.auth as { access_token: string }).access_token).toBe("expired-token");
  });

  it("non-OAuth target (no .refresh metadata) → 401 returned immediately, no refresh attempted", async () => {
    const { services } = makeServices();

    mock.restore();
    mock = installFetchMock([
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]);

    const target = {
      upstreamUrl: SERVER,
      upstreamToken: "static-bearer-bad",
      // No .refresh — static_bearer credential
    };

    const res = await forwardWithRefresh(
      services,
      TENANT,
      target,
      "POST",
      new Headers({ "content-type": "application/json" }),
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    );

    expect(res.status).toBe(401);
    // Exactly one fetch — refresh path skipped because no metadata.
    expect(mock.calls).toHaveLength(1);
  });
});
