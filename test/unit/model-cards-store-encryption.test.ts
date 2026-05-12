// Encryption-roundtrip tests for the model card store. Wires a real
// WebCryptoAesGcm (the production primitive) into createInMemoryModelCardService
// and proves that the api_key path encrypts at rest and decrypts on demand,
// without breaking the api_key_preview invariant.
//
// The existing service unit tests use FakeCrypto. This file complements them
// by exercising the actual AES-256-GCM implementation that production wires
// up — same algorithm, same Web Crypto API, same key derivation.

import { describe, it, expect } from "vitest";
import { apiKeyPreview } from "../../packages/model-cards-store/src/index";
import { createInMemoryModelCardService } from "../../packages/model-cards-store/src/test-fakes";
import { WebCryptoAesGcm } from "../../packages/integrations-adapters-cf/src/crypto";

const TENANT = "tn_test_mdl_enc";
const SECRET = "test-secret-padded-to-be-thirtytwo-chars";

function realCrypto() {
  return new WebCryptoAesGcm(SECRET, "model.cards.keys");
}

describe("ModelCardService — real AES-GCM encryption", () => {
  it("round-trips api_key via getApiKey", async () => {
    const { service } = createInMemoryModelCardService({ crypto: realCrypto() });
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-ant-supersecret-roundtripme-9876",
    });
    const key = await service.getApiKey({ tenantId: TENANT, cardId: card.id });
    expect(key).toBe("sk-ant-supersecret-roundtripme-9876");
  });

  it("api_key_preview matches plaintext last-4 (computed independent of cipher)", async () => {
    const { service } = createInMemoryModelCardService({ crypto: realCrypto() });
    const card = await service.create({
      tenantId: TENANT,
      modelId: "gpt-4o",
      provider: "openai",
      apiKey: "sk-test-very-long-key-ending-1234",
    });
    expect(card.api_key_preview).toBe("1234");
    expect(apiKeyPreview("sk-test-very-long-key-ending-1234")).toBe("1234");
  });

  it("re-encrypts on update and the new key is retrievable", async () => {
    const { service } = createInMemoryModelCardService({ crypto: realCrypto() });
    const card = await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-original-key-aaaa",
    });
    await service.update({
      tenantId: TENANT,
      cardId: card.id,
      apiKey: "sk-rotated-key-bbbb",
    });
    const got = await service.getApiKey({ tenantId: TENANT, cardId: card.id });
    expect(got).toBe("sk-rotated-key-bbbb");
  });

  it("ciphertext does not contain the plaintext", async () => {
    // Sneak a peek at the cipher via a recording crypto wrapper.
    const seen: string[] = [];
    const inner = new WebCryptoAesGcm(SECRET, "model.cards.keys");
    const recording = {
      encrypt: async (plaintext: string) => {
        const cipher = await inner.encrypt(plaintext);
        seen.push(cipher);
        return cipher;
      },
      decrypt: (cipher: string) => inner.decrypt(cipher),
    };

    const { service } = createInMemoryModelCardService({ crypto: recording });
    await service.create({
      tenantId: TENANT,
      modelId: "claude-sonnet-4-6",
      provider: "ant",
      apiKey: "sk-plaintext-marker-abcdef",
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const cipher of seen) {
      expect(cipher).not.toContain("sk-plaintext-marker");
      expect(cipher).not.toContain("abcdef");
    }
  });

  it("rejects ciphertext encrypted under a different label (key isolation)", async () => {
    const cryptoA = new WebCryptoAesGcm(SECRET, "model.cards.keys");
    const cryptoB = new WebCryptoAesGcm(SECRET, "credentials.auth");

    const cipher = await cryptoA.encrypt("sk-secret-from-A");
    await expect(cryptoB.decrypt(cipher)).rejects.toThrow();
  });
});
