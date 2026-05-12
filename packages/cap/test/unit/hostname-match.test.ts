import { describe, it, expect } from "vitest";
import { matchesHostname, validateHostnamePattern } from "../../src/hostname-match";

describe("matchesHostname — exact patterns", () => {
  it("exact pattern matches identical hostname", () => {
    expect(matchesHostname("api.github.com", "api.github.com")).toBe(true);
  });

  it("exact pattern is case-insensitive on host", () => {
    expect(matchesHostname("api.github.com", "API.GitHub.com")).toBe(true);
  });

  it("exact pattern does not match a subdomain", () => {
    expect(matchesHostname("github.com", "api.github.com")).toBe(false);
  });

  it("exact pattern does not match a parent domain", () => {
    expect(matchesHostname("api.github.com", "github.com")).toBe(false);
  });

  it("exact pattern does not match unrelated host", () => {
    expect(matchesHostname("api.github.com", "evil.com")).toBe(false);
  });
});

describe("matchesHostname — wildcard patterns (*.foo.bar)", () => {
  it("wildcard matches a one-segment subdomain", () => {
    expect(matchesHostname("*.amazonaws.com", "s3.amazonaws.com")).toBe(true);
  });

  it("wildcard matches a multi-segment subdomain", () => {
    expect(matchesHostname("*.amazonaws.com", "s3.us-east-1.amazonaws.com")).toBe(true);
  });

  it("wildcard does not match the bare suffix", () => {
    // "*.amazonaws.com" should NOT match "amazonaws.com" — the leading dot
    // is mandatory, mirroring browser cookie-domain semantics.
    expect(matchesHostname("*.amazonaws.com", "amazonaws.com")).toBe(false);
  });

  it("wildcard does not match an unrelated domain", () => {
    expect(matchesHostname("*.amazonaws.com", "evil.com")).toBe(false);
  });

  it("wildcard does not match a domain that ends with the suffix string but isn't a subdomain", () => {
    // "evilamazonaws.com" ends with "amazonaws.com" textually but is not a
    // subdomain. Suffix matching must respect the dot boundary.
    expect(matchesHostname("*.amazonaws.com", "evilamazonaws.com")).toBe(false);
  });

  it("wildcard match is case-insensitive on host", () => {
    expect(matchesHostname("*.amazonaws.com", "S3.AmazonAWS.com")).toBe(true);
  });
});

describe("validateHostnamePattern", () => {
  it("accepts a valid exact pattern", () => {
    expect(() => validateHostnamePattern("api.github.com")).not.toThrow();
  });

  it("accepts a valid leading-wildcard pattern", () => {
    expect(() => validateHostnamePattern("*.amazonaws.com")).not.toThrow();
  });

  it("rejects bare *", () => {
    expect(() => validateHostnamePattern("*")).toThrow(/bare/);
  });

  it("rejects mid-segment wildcard", () => {
    expect(() => validateHostnamePattern("api.*.github.com")).toThrow();
  });

  it("rejects trailing wildcard", () => {
    expect(() => validateHostnamePattern("github.*")).toThrow();
  });

  it("rejects double wildcard", () => {
    expect(() => validateHostnamePattern("**.github.com")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateHostnamePattern("")).toThrow();
  });

  it("rejects pattern containing a slash (caller passed a URL by mistake)", () => {
    expect(() => validateHostnamePattern("https://api.github.com/")).toThrow();
  });

  it("rejects pattern with leading dot", () => {
    expect(() => validateHostnamePattern(".github.com")).toThrow();
  });

  it("rejects wildcard without enough labels (single segment after *)", () => {
    // "*.com" is too broad; require at least two labels after the wildcard
    // to prevent "*.com" / "*.io" footguns in builtin specs.
    expect(() => validateHostnamePattern("*.com")).toThrow();
  });

  it("accepts wildcard with exactly two labels after it", () => {
    expect(() => validateHostnamePattern("*.github.com")).not.toThrow();
  });
});
