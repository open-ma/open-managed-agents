// HMAC-SHA256 verification for incoming webhook signatures.
//
// Linear sends hex-encoded HMAC-SHA256(body, webhook_secret) in the
// `linear-signature` header. Comparison is constant-time via Web Crypto's
// verify() to avoid timing leaks.

import type { HmacVerifier } from "@open-managed-agents/integrations-core";

export class WebCryptoHmacVerifier implements HmacVerifier {
  async verify(secret: string, body: string, signatureHex: string): Promise<boolean> {
    if (!secret || !signatureHex) return false;
    let signature: Uint8Array;
    try {
      signature = hexDecode(signatureHex);
    } catch {
      return false;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      // Node 22+ DOM types narrow BufferSource to Uint8Array<ArrayBuffer>;
      // the Uint8Array we built has the looser ArrayBufferLike. Both runtimes
      // accept either at runtime, so widen via a cast.
      signature as unknown as BufferSource,
      new TextEncoder().encode(body),
    );
  }
}

function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`hex: invalid char at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}
