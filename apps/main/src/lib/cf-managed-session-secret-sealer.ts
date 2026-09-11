import type { SessionResourceSecretSealer } from "@open-managed-agents/managed-agents-adapters-sql";

const IV_BYTES = 12;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class CfManagedSessionSecretSealer
  implements SessionResourceSecretSealer
{
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly rootSecret: string | undefined) {}

  async seal(value: string): Promise<string> {
    if (this.rootSecret === undefined || this.rootSecret.length === 0) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Session resource credentials",
      );
    }
    const key = await this.getKey(this.rootSecret);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(value),
    );
    const payload = new Uint8Array(iv.byteLength + encrypted.byteLength);
    payload.set(iv, 0);
    payload.set(new Uint8Array(encrypted), iv.byteLength);
    return base64Url(payload);
  }

  async open(value: string): Promise<string> {
    if (this.rootSecret === undefined || this.rootSecret.length === 0) {
      throw new Error(
        "PLATFORM_ROOT_SECRET is required for managed Session resource credentials",
      );
    }
    const payload = decodeBase64Url(value);
    if (payload.byteLength <= IV_BYTES) {
      throw new Error("Invalid managed Session resource credential");
    }
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: payload.subarray(0, IV_BYTES) },
      await this.getKey(this.rootSecret),
      payload.subarray(IV_BYTES),
    );
    return new TextDecoder().decode(decrypted);
  }

  private getKey(rootSecret: string): Promise<CryptoKey> {
    this.key ??= crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          `${rootSecret}|managed.sessions.resources`,
        ),
      )
      .then((digest) =>
        crypto.subtle.importKey(
          "raw",
          digest,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.key;
  }
}
