// Unit tests for CredentialService — drives the service against the in-memory
// repo. No D1 binding needed.
//
// Service-level behavior covered: max-per-vault enforcement, mcp_server_url
// immutability, partial-UNIQUE semantics (active-only, NULL-allowed), cascade
// archive, hot read paths used by sessions.ts/outbound.ts, and stripSecrets.
// D1 SQL behavior is exercised via integration tests + manual staging runs.

import { describe, it, expect } from "vitest";
import {
  CredentialDuplicateMcpUrlError,
  CredentialImmutableFieldError,
  CredentialMaxExceededError,
  CredentialNotFoundError,
  MAX_CREDENTIALS_PER_VAULT,
  stripSecrets,
} from "@open-managed-agents/credentials-store";
import {
  ManualClock,
  createInMemoryCredentialService,
} from "@open-managed-agents/credentials-store/test-fakes";

const TENANT = "tn_test_creds";
const VAULT = "vlt_test_a";

describe("CredentialService — create + read", () => {
  it("creates a credential and reads it back", async () => {
    const { service } = createInMemoryCredentialService();
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Linear OAuth",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp.linear.app/sse",
        access_token: "a",
        refresh_token: "r",
      },
    });
    expect(cred.id).toMatch(/^cred-/);
    expect(cred.vault_id).toBe(VAULT);
    expect(cred.archived_at).toBeNull();
    const got = await service.get({ tenantId: TENANT, vaultId: VAULT, credentialId: cred.id });
    expect(got?.display_name).toBe("Linear OAuth");
  });

  it("isolates credentials by tenant", async () => {
    const { service } = createInMemoryCredentialService();
    await service.create({
      tenantId: "tn_a",
      vaultId: VAULT,
      displayName: "A",
      auth: { type: "static_bearer", token: "t" },
    });
    expect((await service.list({ tenantId: "tn_a", vaultId: VAULT })).length).toBe(1);
    expect((await service.list({ tenantId: "tn_b", vaultId: VAULT })).length).toBe(0);
  });

  it("returns null when reading a credential that doesn't exist", async () => {
    const { service } = createInMemoryCredentialService();
    expect(
      await service.get({ tenantId: TENANT, vaultId: VAULT, credentialId: "missing" }),
    ).toBeNull();
  });
});

describe("CredentialService — limits + uniqueness", () => {
  it("rejects the 21st credential in a vault", async () => {
    const { service } = createInMemoryCredentialService();
    for (let i = 0; i < MAX_CREDENTIALS_PER_VAULT; i++) {
      await service.create({
        tenantId: TENANT,
        vaultId: VAULT,
        displayName: `c${i}`,
        auth: { type: "command_secret", env_var: `E_${i}` },
      });
    }
    await expect(
      service.create({
        tenantId: TENANT,
        vaultId: VAULT,
        displayName: "overflow",
        auth: { type: "command_secret", env_var: "E_21" },
      }),
    ).rejects.toBeInstanceOf(CredentialMaxExceededError);
  });

  it("rejects duplicate active mcp_server_url within a vault", async () => {
    const { service } = createInMemoryCredentialService();
    await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "first",
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
    });
    await expect(() =>
      service.create({
        tenantId: TENANT,
        vaultId: VAULT,
        displayName: "second",
        auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
      }),
    ).rejects.toBeInstanceOf(CredentialDuplicateMcpUrlError);
  });

  it("allows re-creating a mcp_server_url after the previous is archived", async () => {
    const { service } = createInMemoryCredentialService();
    const a = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "a",
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
    });
    await service.archive({ tenantId: TENANT, vaultId: VAULT, credentialId: a.id });
    const b = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "b",
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
    });
    expect(b.id).not.toBe(a.id);
    expect(b.archived_at).toBeNull();
  });

  it("allows the same mcp_server_url across different vaults", async () => {
    const { service } = createInMemoryCredentialService();
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_1",
      displayName: "a",
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
    });
    const b = await service.create({
      tenantId: TENANT,
      vaultId: "vlt_2",
      displayName: "b",
      auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.x/sse" },
    });
    expect(b.archived_at).toBeNull();
  });

  it("allows multiple command_secret credentials (no mcp_server_url) in one vault", async () => {
    const { service } = createInMemoryCredentialService();
    for (let i = 0; i < 3; i++) {
      await service.create({
        tenantId: TENANT,
        vaultId: VAULT,
        displayName: `c${i}`,
        auth: { type: "command_secret", env_var: `E_${i}` },
      });
    }
    const list = await service.list({ tenantId: TENANT, vaultId: VAULT });
    expect(list.length).toBe(3);
  });
});

describe("CredentialService — update", () => {
  it("rejects mcp_server_url changes as immutable", async () => {
    const { service } = createInMemoryCredentialService();
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: { type: "mcp_oauth", mcp_server_url: "https://a/sse" },
    });
    await expect(
      service.update({
        tenantId: TENANT,
        vaultId: VAULT,
        credentialId: cred.id,
        auth: { mcp_server_url: "https://b/sse" },
      }),
    ).rejects.toBeInstanceOf(CredentialImmutableFieldError);
  });

  it("merges partial auth updates without dropping existing fields", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryCredentialService({ clock });
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://a/sse",
        access_token: "old",
        refresh_token: "r",
        client_id: "cid",
      },
    });
    clock.set(2000);
    const updated = await service.update({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
      auth: { access_token: "new" },
    });
    expect(updated.auth.access_token).toBe("new");
    expect(updated.auth.refresh_token).toBe("r");
    expect(updated.auth.client_id).toBe("cid");
    expect(updated.auth.mcp_server_url).toBe("https://a/sse");
    expect(updated.updated_at).not.toBeNull();
  });

  it("returns CredentialNotFoundError on update for missing id", async () => {
    const { service } = createInMemoryCredentialService();
    await expect(
      service.update({
        tenantId: TENANT,
        vaultId: VAULT,
        credentialId: "missing",
        displayName: "x",
      }),
    ).rejects.toBeInstanceOf(CredentialNotFoundError);
  });
});

describe("CredentialService — archive + delete", () => {
  it("archive sets archived_at without removing the row", async () => {
    const clock = new ManualClock(5000);
    const { service } = createInMemoryCredentialService({ clock });
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: { type: "static_bearer", token: "t" },
    });
    const archived = await service.archive({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    expect(archived.archived_at).not.toBeNull();
    expect(
      (await service.list({ tenantId: TENANT, vaultId: VAULT })).length,
    ).toBe(1); // includeArchived defaults to true
    expect(
      (await service.list({ tenantId: TENANT, vaultId: VAULT, includeArchived: false })).length,
    ).toBe(0);
  });

  it("delete removes the row entirely", async () => {
    const { service } = createInMemoryCredentialService();
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: { type: "static_bearer", token: "t" },
    });
    await service.delete({ tenantId: TENANT, vaultId: VAULT, credentialId: cred.id });
    expect(
      await service.get({ tenantId: TENANT, vaultId: VAULT, credentialId: cred.id }),
    ).toBeNull();
  });
});

describe("CredentialService — cascade archive (archiveByVault)", () => {
  it("archives all active credentials in a vault, leaves other vaults untouched", async () => {
    const clock = new ManualClock(7000);
    const { service } = createInMemoryCredentialService({ clock });
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_1",
      displayName: "a",
      auth: { type: "static_bearer", token: "ta" },
    });
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_1",
      displayName: "b",
      auth: { type: "static_bearer", token: "tb" },
    });
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_2",
      displayName: "c",
      auth: { type: "static_bearer", token: "tc" },
    });

    await service.archiveByVault({ tenantId: TENANT, vaultId: "vlt_1" });

    const v1 = await service.list({ tenantId: TENANT, vaultId: "vlt_1" });
    const v2 = await service.list({ tenantId: TENANT, vaultId: "vlt_2" });
    expect(v1.every((c) => c.archived_at !== null)).toBe(true);
    expect(v2.every((c) => c.archived_at === null)).toBe(true);
  });

  it("does not re-archive already-archived credentials (preserves original timestamp)", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryCredentialService({ clock });
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: { type: "static_bearer", token: "t" },
    });
    clock.set(2000);
    const firstArchive = await service.archive({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    clock.set(3000);
    await service.archiveByVault({ tenantId: TENANT, vaultId: VAULT });
    const after = await service.get({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
    });
    expect(after?.archived_at).toBe(firstArchive.archived_at);
  });
});

describe("CredentialService — hot read paths (sessions.ts + outbound.ts)", () => {
  it("listByVaults returns one bucket per requested vault, in order", async () => {
    const { service } = createInMemoryCredentialService();
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_a",
      displayName: "x",
      auth: { type: "static_bearer", token: "t" },
    });
    await service.create({
      tenantId: TENANT,
      vaultId: "vlt_b",
      displayName: "y",
      auth: { type: "static_bearer", token: "t" },
    });
    const out = await service.listByVaults({
      tenantId: TENANT,
      vaultIds: ["vlt_b", "vlt_a", "vlt_empty"],
    });
    expect(out.map((b) => b.vault_id)).toEqual(["vlt_b", "vlt_a", "vlt_empty"]);
    expect(out[0].credentials.length).toBe(1);
    expect(out[2].credentials.length).toBe(0);
  });

  it("listProviderTagged returns only provider-tagged active credentials", async () => {
    const { service } = createInMemoryCredentialService();
    await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "no provider",
      auth: { type: "mcp_oauth", mcp_server_url: "https://x/sse" },
    });
    const tagged = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "github tagged",
      auth: { type: "mcp_oauth", mcp_server_url: "https://gh/sse", provider: "github" },
    });
    const archived = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "archived linear",
      auth: { type: "mcp_oauth", mcp_server_url: "https://ln/sse", provider: "linear" },
    });
    await service.archive({ tenantId: TENANT, vaultId: VAULT, credentialId: archived.id });

    const out = await service.listProviderTagged({ tenantId: TENANT, vaultIds: [VAULT] });
    expect(out.map((c) => c.id)).toEqual([tagged.id]);
  });

  it("refreshAuth merges new tokens and bumps updated_at", async () => {
    const clock = new ManualClock(1000);
    const { service } = createInMemoryCredentialService({ clock });
    const cred = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "x",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://x/sse",
        access_token: "old",
        refresh_token: "r1",
      },
    });
    clock.set(2000);
    const updated = await service.refreshAuth({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: cred.id,
      auth: { access_token: "new", refresh_token: "r2", expires_at: "2030-01-01T00:00:00.000Z" },
    });
    expect(updated?.auth.access_token).toBe("new");
    expect(updated?.auth.refresh_token).toBe("r2");
    expect(updated?.auth.expires_at).toBe("2030-01-01T00:00:00.000Z");
    expect(updated?.auth.mcp_server_url).toBe("https://x/sse");
  });

  it("refreshAuth returns null when credential is missing (no throw)", async () => {
    const { service } = createInMemoryCredentialService();
    const out = await service.refreshAuth({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: "missing",
      auth: { access_token: "new" },
    });
    expect(out).toBeNull();
  });
});

describe("stripSecrets", () => {
  it("removes token + access_token + refresh_token + client_secret, keeps the rest", () => {
    const cred = {
      id: "cred-1",
      tenant_id: "t",
      vault_id: "v",
      display_name: "x",
      auth: {
        type: "mcp_oauth" as const,
        mcp_server_url: "https://x/sse",
        access_token: "secret_a",
        refresh_token: "secret_r",
        client_id: "cid",
        client_secret: "secret_cs",
        token: "secret_t",
        provider: "github" as const,
      },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: null,
      archived_at: null,
    };
    const stripped = stripSecrets(cred);
    expect(stripped.auth.access_token).toBeUndefined();
    expect(stripped.auth.refresh_token).toBeUndefined();
    expect(stripped.auth.client_secret).toBeUndefined();
    expect(stripped.auth.token).toBeUndefined();
    expect(stripped.auth.mcp_server_url).toBe("https://x/sse");
    expect(stripped.auth.client_id).toBe("cid");
    expect(stripped.auth.provider).toBe("github");
    // Original is not mutated
    expect(cred.auth.access_token).toBe("secret_a");
  });
});
