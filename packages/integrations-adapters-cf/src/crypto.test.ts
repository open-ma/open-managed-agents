// Roundtrip tests for WebCryptoAesGcm. The class has been in production for
// integration token encryption since OPE-7, but until now had no tests of its
// own — these fill that gap.

import { describe, it, expect } from "vitest";
import { WebCryptoAesGcm } from "./crypto";

const SECRET = "test-secret-at-least-32-chars-for-realism";

describe("WebCryptoAesGcm", () => {
  it("roundtrips an arbitrary string", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    const cipher = await c.encrypt("hello world");
    const round = await c.decrypt(cipher);
    expect(round).toBe("hello world");
  });

  it("produces a different ciphertext each call (random IV)", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    const a = await c.encrypt("same plaintext");
    const b = await c.encrypt("same plaintext");
    expect(a).not.toBe(b);
    expect(await c.decrypt(a)).toBe("same plaintext");
    expect(await c.decrypt(b)).toBe("same plaintext");
  });

  it("emits ciphertext that does not contain the plaintext", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    const cipher = await c.encrypt("sk-abc-very-secret");
    expect(cipher).not.toContain("sk-abc");
    expect(cipher).not.toContain("very-secret");
  });

  it("isolates ciphertexts by label (HKDF-style derivation)", async () => {
    const a = new WebCryptoAesGcm(SECRET, "label.alpha");
    const b = new WebCryptoAesGcm(SECRET, "label.beta");
    const cipher = await a.encrypt("hello");
    await expect(b.decrypt(cipher)).rejects.toThrow();
  });

  it("isolates ciphertexts by secret", async () => {
    const a = new WebCryptoAesGcm("secret-A-padded-to-be-long-enough", "test.label");
    const b = new WebCryptoAesGcm("secret-B-padded-to-be-long-enough", "test.label");
    const cipher = await a.encrypt("hello");
    await expect(b.decrypt(cipher)).rejects.toThrow();
  });

  it("uses default label 'integrations.tokens' when none given", async () => {
    const explicit = new WebCryptoAesGcm(SECRET, "integrations.tokens");
    const implicit = new WebCryptoAesGcm(SECRET);
    const cipher = await explicit.encrypt("token");
    expect(await implicit.decrypt(cipher)).toBe("token");
  });

  it("rejects empty secret in constructor", () => {
    expect(() => new WebCryptoAesGcm("", "test.label")).toThrow(/non-empty/);
  });

  it("rejects ciphertext shorter than the IV", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    // base64url for 4 bytes (less than the 12-byte IV)
    await expect(c.decrypt("AAAAAA")).rejects.toThrow();
  });

  it("handles unicode plaintext", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    const cipher = await c.encrypt("你好 🌍 emoji");
    expect(await c.decrypt(cipher)).toBe("你好 🌍 emoji");
  });

  it("handles empty-string plaintext", async () => {
    const c = new WebCryptoAesGcm(SECRET, "test.label");
    const cipher = await c.encrypt("");
    expect(await c.decrypt(cipher)).toBe("");
  });
});
