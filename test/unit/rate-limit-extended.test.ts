// @ts-nocheck
import { describe, it, expect, beforeEach } from "vitest";
import { isRateLimited, windows } from "../../apps/main/src/rate-limit";

describe("Rate limiting — extended", () => {
  beforeEach(() => {
    windows.clear();
  });

  it("request at exact limit (5th request with limit=5) is still allowed", () => {
    const key = "exact-limit";
    // Requests 1-4
    for (let i = 0; i < 4; i++) {
      expect(isRateLimited(key, 5, 60000)).toBe(false);
    }
    // 5th request should still be allowed (limit=5 means 5 are allowed)
    expect(isRateLimited(key, 5, 60000)).toBe(false);
  });

  it("first request over limit (6th with limit=5) is blocked", () => {
    const key = "over-limit";
    // Use up all 5 allowed requests
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(key, 5, 60000)).toBe(false);
    }
    // 6th request should be blocked
    expect(isRateLimited(key, 5, 60000)).toBe(true);
  });

  it("different rate keys are independent", () => {
    const keyA = "key-a:write";
    const keyB = "key-b:write";
    // Exhaust keyA
    for (let i = 0; i < 3; i++) {
      isRateLimited(keyA, 3, 60000);
    }
    expect(isRateLimited(keyA, 3, 60000)).toBe(true);
    // keyB should still be available
    expect(isRateLimited(keyB, 3, 60000)).toBe(false);
  });

  it("very high limit (10000) allows many requests", () => {
    const key = "high-limit";
    for (let i = 0; i < 500; i++) {
      expect(isRateLimited(key, 10000, 60000)).toBe(false);
    }
  });

  it("limit of 1 blocks second request immediately", () => {
    const key = "limit-one";
    expect(isRateLimited(key, 1, 60000)).toBe(false);
    expect(isRateLimited(key, 1, 60000)).toBe(true);
  });

  it("windows.clear() resets all state", () => {
    const key = "clear-test";
    // Fill up the limit
    for (let i = 0; i < 5; i++) {
      isRateLimited(key, 5, 60000);
    }
    expect(isRateLimited(key, 5, 60000)).toBe(true);
    // Clear all windows
    windows.clear();
    expect(windows.size).toBe(0);
  });

  it("subsequent requests after clear are allowed", () => {
    const key = "after-clear";
    // Fill up the limit
    for (let i = 0; i < 3; i++) {
      isRateLimited(key, 3, 60000);
    }
    expect(isRateLimited(key, 3, 60000)).toBe(true);
    // Clear and try again
    windows.clear();
    expect(isRateLimited(key, 3, 60000)).toBe(false);
    expect(isRateLimited(key, 3, 60000)).toBe(false);
  });

  it("empty string key works normally", () => {
    const key = "";
    expect(isRateLimited(key, 2, 60000)).toBe(false);
    expect(isRateLimited(key, 2, 60000)).toBe(false);
    expect(isRateLimited(key, 2, 60000)).toBe(true);
  });

  it("single request with limit=1 is allowed", () => {
    const key = "single";
    expect(isRateLimited(key, 1, 60000)).toBe(false);
  });

  it("100 rapid requests with limit=100 are all allowed, 101st is blocked", () => {
    const key = "rapid-100";
    for (let i = 0; i < 100; i++) {
      expect(isRateLimited(key, 100, 60000)).toBe(false);
    }
    expect(isRateLimited(key, 100, 60000)).toBe(true);
  });
});
