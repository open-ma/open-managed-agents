// Random id generator backed by Web Crypto. 32 bytes of entropy → base64url
// (43 chars) by default; callers can configure prefixes for log readability.

import type { IdGenerator } from "@open-managed-agents/integrations-core";

export class CryptoIdGenerator implements IdGenerator {
  /**
   * @param prefix optional namespace prepended with "_" (e.g. "inst", "pub").
   * Aids log debugging without affecting uniqueness.
   * @param entropyBytes raw bytes generated; default 32 ≈ 256 bits.
   */
  constructor(
    private readonly prefix: string = "",
    private readonly entropyBytes: number = 32,
  ) {}

  generate(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(this.entropyBytes));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const encoded = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return this.prefix ? `${this.prefix}_${encoded}` : encoded;
  }
}
