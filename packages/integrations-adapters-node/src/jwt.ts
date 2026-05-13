// HS256 JWT signer/verifier for short-lived MCP scope tokens.
//
// Minimal implementation — no audience/issuer validation, no key rotation,
// no kid header. Tokens are session-bounded so churn handles rotation.

import type { JwtSigner } from "@open-managed-agents/integrations-core";

const HEADER_B64 = base64UrlEncodeStr('{"alg":"HS256","typ":"JWT"}');

export class WebCryptoJwtSigner implements JwtSigner {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly secret: string) {
    if (!secret) throw new Error("WebCryptoJwtSigner: secret must be non-empty");
  }

  private getKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(this.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    }
    return this.keyPromise;
  }

  async sign(payload: object, ttlSeconds: number): Promise<string> {
    const key = await this.getKey();
    const now = Math.floor(Date.now() / 1000);
    const fullPayload = { ...payload, iat: now, exp: now + ttlSeconds };
    const payloadB64 = base64UrlEncodeStr(JSON.stringify(fullPayload));
    const signingInput = `${HEADER_B64}.${payloadB64}`;
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signingInput),
    );
    const sigB64 = base64UrlEncodeBytes(new Uint8Array(signature));
    return `${signingInput}.${sigB64}`;
  }

  async verify<T extends object = object>(token: string): Promise<T> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("JwtSigner.verify: malformed token");
    const [headerB64, payloadB64, sigB64] = parts;
    const key = await this.getKey();
    const sig = base64UrlDecode(sigB64);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sig as unknown as BufferSource,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!ok) throw new Error("JwtSigner.verify: signature mismatch");
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as { exp?: number };
    if (payload.exp !== undefined && payload.exp * 1000 < Date.now()) {
      throw new Error("JwtSigner.verify: token expired");
    }
    return payload as T;
  }
}

function base64UrlEncodeStr(s: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(s));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
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
