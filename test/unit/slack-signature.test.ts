import { describe, it, expect } from "vitest";
import {
  buildBaseString,
  isTimestampFresh,
  MAX_TIMESTAMP_SKEW_SECONDS,
  parseSignatureHeader,
} from "../../packages/slack/src/webhook/signature";

describe("Slack signature helpers", () => {
  describe("buildBaseString", () => {
    it("formats v0 basestring as v0:{ts}:{body}", () => {
      expect(buildBaseString("1700000000", '{"hello":"world"}')).toBe(
        'v0:1700000000:{"hello":"world"}',
      );
    });

    it("preserves whitespace and ordering inside the body", () => {
      const body = `{ "type": "event_callback",  "event_id" : "Ev01"  }`;
      expect(buildBaseString("123", body)).toBe(`v0:123:${body}`);
    });
  });

  describe("parseSignatureHeader", () => {
    it("parses v0=<hex>", () => {
      const r = parseSignatureHeader("v0=abc123def456");
      expect(r).toEqual({ version: "v0", hex: "abc123def456" });
    });

    it("normalizes case", () => {
      const r = parseSignatureHeader("V0=ABCDEF");
      expect(r).toEqual({ version: "v0", hex: "abcdef" });
    });

    it("returns null on missing", () => {
      expect(parseSignatureHeader(undefined)).toBeNull();
      expect(parseSignatureHeader("")).toBeNull();
    });

    it("returns null on malformed values", () => {
      expect(parseSignatureHeader("hmac=abc")).toBeNull();
      expect(parseSignatureHeader("v0:abc")).toBeNull();
      expect(parseSignatureHeader("v0=NOT-HEX!")).toBeNull();
    });
  });

  describe("isTimestampFresh", () => {
    const NOW_MS = 1_700_000_000_000;
    it("accepts timestamps within ±5 minutes by default", () => {
      expect(isTimestampFresh("1700000000", NOW_MS)).toBe(true);
      expect(isTimestampFresh(String(1700000000 - 60), NOW_MS)).toBe(true);
      expect(isTimestampFresh(String(1700000000 + 60), NOW_MS)).toBe(true);
    });

    it("rejects timestamps older than the skew limit", () => {
      const oldTs = String(1700000000 - MAX_TIMESTAMP_SKEW_SECONDS - 1);
      expect(isTimestampFresh(oldTs, NOW_MS)).toBe(false);
    });

    it("rejects timestamps too far in the future", () => {
      const futureTs = String(1700000000 + MAX_TIMESTAMP_SKEW_SECONDS + 1);
      expect(isTimestampFresh(futureTs, NOW_MS)).toBe(false);
    });

    it("rejects non-numeric / negative values", () => {
      expect(isTimestampFresh("abc", NOW_MS)).toBe(false);
      expect(isTimestampFresh("0", NOW_MS)).toBe(false);
      expect(isTimestampFresh("-1700000000", NOW_MS)).toBe(false);
    });
  });
});
