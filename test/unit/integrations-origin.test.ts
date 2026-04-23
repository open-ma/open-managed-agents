// Regression test for ultrareview bug_010.
//
// Linear-triggered sessions need to know the integrations gateway origin
// so they can mint MCP URLs for the bot to call back. Previously the code
// silently fell back to a localhost default; in prod that meant minting
// MCP URLs (and per-session bearer tokens) pointing at a hostname the bot
// couldn't actually reach. We now hard-fail at session-create time when
// INTEGRATIONS_ORIGIN is unset.

import { describe, it, expect } from "vitest";
import { __testInternals } from "../../apps/main/src/routes/internal";

const { integrationsOrigin } = __testInternals;

describe("integrationsOrigin (ultrareview bug_010)", () => {
  it("returns the explicit value when set", () => {
    expect(
      integrationsOrigin({ INTEGRATIONS_ORIGIN: "https://integrations.example.com" } as any),
    ).toBe("https://integrations.example.com");
  });

  it("throws when env var is undefined (no silent localhost fallback)", () => {
    expect(() => integrationsOrigin({} as any)).toThrow(/INTEGRATIONS_ORIGIN/);
  });

  it("throws when env var is empty string", () => {
    expect(() => integrationsOrigin({ INTEGRATIONS_ORIGIN: "" } as any)).toThrow(
      /INTEGRATIONS_ORIGIN/,
    );
  });

  it("error message names the var so ops can grep for it", () => {
    let caught: Error | undefined;
    try {
      integrationsOrigin({} as any);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toMatch(/INTEGRATIONS_ORIGIN/);
    expect(caught?.message).toMatch(/refusing|not configured/);
  });
});
