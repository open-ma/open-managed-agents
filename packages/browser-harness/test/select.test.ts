import { describe, it, expect } from "vitest";
import { selectBrowserHarness } from "../src/select";

// We can't actually load playwright-core in CI without a chromium binary,
// so the dispatch test exercises the resolution logic with a fake
// resolver. The real wire-up in apps/main-node calls this same helper
// with require.resolve as the resolver.

describe("selectBrowserHarness (env-driven dispatch)", () => {
  it("returns CDP harness when BROWSERLESS_URL is set", async () => {
    const { kind } = await selectBrowserHarness({
      env: { BROWSERLESS_URL: "ws://browserless:3000" },
      hasPlaywrightCore: () => true,
    });
    expect(kind).toBe("cdp");
  });

  it("BROWSER_REMOTE_URL is recognised as an alias for BROWSERLESS_URL", async () => {
    const { kind } = await selectBrowserHarness({
      env: { BROWSER_REMOTE_URL: "ws://pool:9222" },
      hasPlaywrightCore: () => true,
    });
    expect(kind).toBe("cdp");
  });

  it("falls back to Node-Playwright when playwright-core resolves and no remote URL", async () => {
    const { kind } = await selectBrowserHarness({
      env: {},
      hasPlaywrightCore: () => true,
    });
    expect(kind).toBe("node");
  });

  it("respects BROWSER_EXECUTABLE_PATH on the Node path", async () => {
    const { kind, executablePath } = await selectBrowserHarness({
      env: { BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium-browser" },
      hasPlaywrightCore: () => true,
    });
    expect(kind).toBe("node");
    expect(executablePath).toBe("/usr/bin/chromium-browser");
  });

  it("returns Disabled when no playwright-core, no remote URL, no exec path", async () => {
    const { kind } = await selectBrowserHarness({
      env: {},
      hasPlaywrightCore: () => false,
    });
    expect(kind).toBe("disabled");
  });

  it("CDP dispatch wins even if playwright-core is missing — connect doesn't need a local binary", async () => {
    const { kind } = await selectBrowserHarness({
      env: { BROWSERLESS_URL: "wss://chrome.browserless.io?token=xxx" },
      hasPlaywrightCore: () => false,
    });
    // BROWSERLESS_URL still picks cdp; the lazy import will fail at
    // launch() with a clearer error pointing at the missing peer dep.
    expect(kind).toBe("cdp");
  });
});
