// @ts-nocheck
// E2E for cap_cli credential injection through the outbound proxy path.
//
// Drives `resolveOutboundCredentialByHost` (apps/main/src/routes/mcp-proxy.ts)
// against in-memory services seeded with:
//   - a session whose vault_ids reference one vault
//   - a cap_cli credential in that vault (cli_id="gh", token=...)
//
// Expectation: when the agent's sandbox makes an outbound request to a
// hostname that cap's spec registry knows (`api.github.com` etc.), the
// proxy resolves to the cap_cli credential's token. The hostname-based
// match is driven by cap's builtinSpecs, not by per-credential
// mcp_server_url, which is the whole point of cap_cli.

import { describe, it, expect } from "vitest";
import { resolveOutboundCredentialByHost } from "../../apps/main/src/routes/mcp-proxy";
import { createInMemoryCredentialService } from "../../packages/credentials-store/src/test-fakes";
import type { Services } from "../../packages/services/src/index";

const TENANT = "tn_test";
const SESSION = "ses_test";
const VAULT = "vlt_test";

function makeServices(opts: {
  vaultIds: string[];
  archived?: boolean;
}): { services: Services; credService: ReturnType<typeof createInMemoryCredentialService>["service"] } {
  const { service: credService } = createInMemoryCredentialService();
  // Minimal sessions service stub; only `get` is used by the resolver.
  const sessions = {
    get: async (q: { tenantId: string; sessionId: string }) => {
      if (q.tenantId !== TENANT || q.sessionId !== SESSION) return null;
      return {
        id: SESSION,
        tenant_id: TENANT,
        vault_ids: opts.vaultIds,
        archived_at: opts.archived ? new Date().toISOString() : null,
      };
    },
  };
  const services = { credentials: credService, sessions } as unknown as Services;
  return { services, credService };
}

describe("resolveOutboundCredentialByHost — cap_cli", () => {
  it("matches api.github.com → gh cap_cli credential and returns its token", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH",
      auth: { type: "cap_cli", cli_id: "gh", token: "ghp_real_xyz" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "api.github.com",
    );
    expect(target).not.toBeNull();
    expect(target!.upstreamToken).toBe("ghp_real_xyz");
  });

  it("uploads.github.com also routes to the gh cap_cli credential (multi-endpoint spec)", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH",
      auth: { type: "cap_cli", cli_id: "gh", token: "ghp_real_xyz" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "uploads.github.com",
    );
    expect(target).not.toBeNull();
    expect(target!.upstreamToken).toBe("ghp_real_xyz");
  });

  it("gcloud spec has multiple exact endpoints — both metadata hosts route to the same cap_cli credential", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GCP",
      auth: { type: "cap_cli", cli_id: "gcloud", token: "ya29.gcp_token" } as never,
    });

    for (const host of ["metadata.google.internal", "169.254.169.254"]) {
      const target = await resolveOutboundCredentialByHost(
        {} as never,
        services,
        TENANT,
        SESSION,
        host,
      );
      expect(target, `host=${host}`).not.toBeNull();
      expect(target!.upstreamToken).toBe("ya29.gcp_token");
    }
  });

  it("hostname not in cap registry → returns null (no spec match)", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH",
      auth: { type: "cap_cli", cli_id: "gh", token: "ghp_real_xyz" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "evil.example.com",
    );
    expect(target).toBeNull();
  });

  it("hostname matches cap spec but no matching cap_cli credential → returns null", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    // Vault has a gh credential, but request targets gitlab.
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH",
      auth: { type: "cap_cli", cli_id: "gh", token: "ghp_real_xyz" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "gitlab.com",
    );
    expect(target).toBeNull();
  });

  it("session has no vaults → returns null without error", async () => {
    const { services } = makeServices({ vaultIds: [] });
    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "api.github.com",
    );
    expect(target).toBeNull();
  });

  it("archived session → returns null (revoked credentials shouldn't leak)", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT], archived: true });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH",
      auth: { type: "cap_cli", cli_id: "gh", token: "ghp_real_xyz" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "api.github.com",
    );
    expect(target).toBeNull();
  });

  it("cap_cli credential without a token → skipped, returns null", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "GH (broken)",
      auth: { type: "cap_cli", cli_id: "gh" } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "api.github.com",
    );
    expect(target).toBeNull();
  });

  it("legacy mcp_oauth credential still works for non-cap hostnames (Linear etc.)", async () => {
    const { services, credService } = makeServices({ vaultIds: [VAULT] });
    await credService.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Linear MCP",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp.linear.app/mcp",
        access_token: "linear_at",
        refresh_token: "linear_rt",
        token_endpoint: "https://linear.app/oauth/token",
      } as never,
    });

    const target = await resolveOutboundCredentialByHost(
      {} as never,
      services,
      TENANT,
      SESSION,
      "mcp.linear.app",
    );
    expect(target).not.toBeNull();
    expect(target!.upstreamToken).toBe("linear_at");
    // Legacy mcp_oauth path also surfaces refresh metadata.
    expect(target!.refresh).toBeDefined();
  });
});
