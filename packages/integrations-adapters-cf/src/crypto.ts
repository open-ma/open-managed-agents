// AES-GCM symmetric encryption via Web Crypto, scoped per-key.
//
// The key is derived from a stable secret (passed by the worker as a wrangler
// secret). All ciphertexts produced by one key can only be read back by the
// same key — rotating the secret would orphan stored data, so introduce a
// new instance with a versioned prefix if rotation is ever needed.

import type { Crypto } from "@open-managed-agents/integrations-core";

const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32; // AES-256

export class WebCryptoAesGcm implements Crypto {
  /** Lazily derived; not exposed. */
  private keyPromise: Promise<CryptoKey> | null = null;

  /**
   * @param secret stable string secret. ≥32 bytes recommended; shorter inputs
   * are stretched via SHA-256 before key import. The same `secret` MUST be
   * used to decrypt anything previously encrypted.
   * @param label additional context mixed into key derivation; defaults to
   * "integrations.tokens" so different uses (e.g. JWT vs Linear tokens) can
   * derive distinct keys from the same root secret.
   */
  constructor(
    private readonly secret: string,
    private readonly label: string = "integrations.tokens",
  ) {
    if (!secret) throw new Error("WebCryptoAesGcm: secret must be non-empty");
  }

  private async importKey(): Promise<CryptoKey> {
    // HKDF-style: SHA-256(secret || label) → 32 bytes → AES-256-GCM key
    const seedBytes = new TextEncoder().encode(`${this.secret}|${this.label}`);
    const digest = await crypto.subtle.digest("SHA-256", seedBytes);
    return crypto.subtle.importKey(
      "raw",
      digest.slice(0, KEY_BYTES),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  private async getKey(): Promise<CryptoKey> {
    if (!this.keyPromise) this.keyPromise = this.importKey();
    return this.keyPromise;
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    );
    // Format: base64url(iv || ciphertext)
    const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.byteLength);
    return base64UrlEncode(combined);
  }

  async decrypt(ciphertext: string): Promise<string> {
    const key = await this.getKey();
    const combined = base64UrlDecode(ciphertext);
    if (combined.byteLength <= IV_BYTES) {
      throw new Error("WebCryptoAesGcm.decrypt: ciphertext too short");
    }
    const iv = combined.slice(0, IV_BYTES);
    const data = combined.slice(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );
    return new TextDecoder().decode(plaintext);
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
