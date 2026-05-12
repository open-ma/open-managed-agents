// Encryption-boundary tests for the credentials store. Wires
// CredentialService against an InMemoryCredentialRepo + FakeCrypto and proves:
//   1. The on-disk blob (auth_cipher) is the cipher, not the plaintext JSON.
//   2. Round-trip via service.create → service.get returns the original auth.
//   3. Partial-update merge semantics still work after encryption was added
//      (read-merge-write happens on plaintext-typed rows, repo re-encrypts).
//   4. stripSecrets operates on the decrypted output, removing the same
//      fields it always did.
//   5. Hot-path columns (mcp_server_url, provider) remain queryable — the
//      partial UNIQUE check fires regardless of encryption.
//
// The InMemoryCredentialRepo intentionally mirrors SqlCredentialRepo's
// encrypt-on-write / decrypt-on-read boundary so this unit test exercises the
// same semantics that production hits.

import { describe, it, expect } from "vitest";
import {
  CredentialDuplicateMcpUrlError,
  stripSecrets,
} from "../../packages/credentials-store/src/index";
import {
  FakeCrypto,
  ManualClock,
  createInMemoryCredentialService,
} from "../../packages/credentials-store/src/test-fakes";

const TENANT = "tn_test_enc";
const VAULT = "vlt_test_enc";

describe("CredentialService — encryption boundary", () => {
  it("stores the cipher on disk, not the plaintext JSON", async () => {
    const { service, repo } = createInMemoryCredentialService({
      crypto: new FakeCrypto(),
    });
    const created = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "OAuth cred",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp.example.com",
        access_token: "sk-very-secret-access-token",
        refresh_token: "rt-very-secret-refresh-token",
      },
    });

    const raw = repo.__getRawAuthCipher(created.id);
    expect(raw).toBeDefined();
    // FakeCrypto wraps with `enc(...)` — proves encryption was called.
    expect(raw!.startsWith("enc(")).toBe(true);
    expect(raw!.endsWith(")")).toBe(true);
    // The plaintext secrets must not appear in the on-disk blob in raw form;
    // FakeCrypto's "enc(" wrapper carries the JSON inside, so we strip the
    // wrapper and verify the inner payload IS the JSON (proving the cipher
    // is what's persisted, not the parsed object). With a real WebCryptoAesGcm
    // the secrets wouldn't appear at all — that's covered by the model-cards
    // and integrations roundtrip suites.
    const inner = raw!.slice(4, -1);
    expect(JSON.parse(inner).access_token).toBe("sk-very-secret-access-token");
  });

  it("round-trips the auth blob through create → get", async () => {
    const { service } = createInMemoryCredentialService({
      crypto: new FakeCrypto(),
    });
    const auth = {
      type: "static_bearer" as const,
      mcp_server_url: "https://api.example.com",
      token: "bearer-token-12345",
    };
    const created = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "Bearer cred",
      auth,
    });

    const fetched = await service.get({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: created.id,
    });
    expect(fetched).not.toBeNull();
    expect(fetched!.auth).toEqual(auth);
  });

  it("preserves untouched fields across partial-update merges", async () => {
    const clock = new ManualClock(1_000_000);
    const { service } = createInMemoryCredentialService({
      clock,
      crypto: new FakeCrypto(),
    });
    const created = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "OAuth",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp.example.com",
        access_token: "old-access",
        refresh_token: "old-refresh",
        client_id: "client-abc",
        client_secret: "secret-xyz",
        token_endpoint: "https://mcp.example.com/oauth/token",
      },
    });

    clock.advance(60_000);
    const updated = await service.update({
      tenantId: TENANT,
      vaultId: VAULT,
      credentialId: created.id,
      auth: { access_token: "new-access" },
    });

    // Partial merge: access_token replaced, everything else preserved.
    expect(updated.auth.access_token).toBe("new-access");
    expect(updated.auth.refresh_token).toBe("old-refresh");
    expect(updated.auth.client_id).toBe("client-abc");
    expect(updated.auth.client_secret).toBe("secret-xyz");
    expect(updated.auth.mcp_server_url).toBe("https://mcp.example.com");
    expect(updated.auth.type).toBe("mcp_oauth");
  });

  it("stripSecrets still removes secret fields after encryption is wired", async () => {
    const { service } = createInMemoryCredentialService({
      crypto: new FakeCrypto(),
    });
    const created = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "OAuth",
      auth: {
        type: "mcp_oauth",
        mcp_server_url: "https://mcp.example.com",
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        client_secret: "secret-client",
        client_id: "client-id-not-secret",
      },
    });

    const stripped = stripSecrets(created);
    expect(stripped.auth.access_token).toBeUndefined();
    expect(stripped.auth.refresh_token).toBeUndefined();
    expect(stripped.auth.client_secret).toBeUndefined();
    // Non-secret fields preserved.
    expect(stripped.auth.client_id).toBe("client-id-not-secret");
    expect(stripped.auth.mcp_server_url).toBe("https://mcp.example.com");
  });

  it("partial UNIQUE on mcp_server_url fires regardless of encryption (denormalized column intact)", async () => {
    const { service } = createInMemoryCredentialService({
      crypto: new FakeCrypto(),
    });
    await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "First",
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://shared.example.com",
        token: "first-token",
      },
    });
    await expect(
      service.create({
        tenantId: TENANT,
        vaultId: VAULT,
        displayName: "Second",
        auth: {
          type: "static_bearer",
          mcp_server_url: "https://shared.example.com",
          token: "second-token",
        },
      }),
    ).rejects.toBeInstanceOf(CredentialDuplicateMcpUrlError);
  });

  it("decrypt failure surfaces — corrupted on-disk blob throws on read", async () => {
    const { service, repo } = createInMemoryCredentialService({
      crypto: new FakeCrypto(),
    });
    const created = await service.create({
      tenantId: TENANT,
      vaultId: VAULT,
      displayName: "tampered",
      auth: { type: "static_bearer", token: "ok" },
    });
    // Corrupt the cipher: drop the FakeCrypto wrapper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (repo as any).byId.get(created.id).auth_cipher = "garbage-no-wrapper";
    await expect(
      service.get({
        tenantId: TENANT,
        vaultId: VAULT,
        credentialId: created.id,
      }),
    ).rejects.toThrow(/not a fake-cipher/);
  });
});
