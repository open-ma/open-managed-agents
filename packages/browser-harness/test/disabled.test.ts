import { describe, it, expect } from "vitest";
import { buildBrowserTools, NotSupportedError } from "../src/index";
import {
  createDisabledBrowserHarness,
  DEFAULT_DISABLED_MESSAGE,
} from "../src/disabled";

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abortSignal: undefined as any,
};

describe("Disabled browser harness", () => {
  it("launch() throws NotSupportedError with the documented message", async () => {
    const harness = createDisabledBrowserHarness();
    await expect(harness.launch()).rejects.toBeInstanceOf(NotSupportedError);
    await expect(harness.launch()).rejects.toThrow(DEFAULT_DISABLED_MESSAGE);
  });

  it("launch() respects a custom message override", async () => {
    const harness = createDisabledBrowserHarness("custom explanation");
    await expect(harness.launch()).rejects.toThrow("custom explanation");
  });
});

describe("buildBrowserTools wraps the Disabled harness cleanly", () => {
  it("returns the standard browser_* tool set when a harness is given", () => {
    const tools = buildBrowserTools(createDisabledBrowserHarness());
    const names = Object.keys(tools).sort();
    expect(names).toEqual([
      "browser_click",
      "browser_close",
      "browser_eval",
      "browser_get_text",
      "browser_navigate",
      "browser_screenshot",
      "browser_type",
    ]);
  });

  it("returns an empty tool set when harness is null", () => {
    expect(buildBrowserTools(null)).toEqual({});
  });

  it("browser_navigate surfaces NotSupportedError as a string result the LLM can read", async () => {
    const tools = buildBrowserTools(createDisabledBrowserHarness());
    const out = await tools.browser_navigate.execute(
      { url: "https://example.com" },
      TOOL_EXEC_OPTS,
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("Navigate error");
    expect(out).toContain(DEFAULT_DISABLED_MESSAGE);
  });

  it("browser_screenshot surfaces NotSupportedError as a string (not a partial image)", async () => {
    const tools = buildBrowserTools(createDisabledBrowserHarness());
    const out = await tools.browser_screenshot.execute({}, TOOL_EXEC_OPTS);
    expect(typeof out).toBe("string");
    expect(out).toContain("Screenshot error");
    expect(out).toContain(DEFAULT_DISABLED_MESSAGE);
  });

  it("browser_close on a harness whose session never launched is a no-op", async () => {
    const tools = buildBrowserTools(createDisabledBrowserHarness());
    const out = await tools.browser_close.execute({}, TOOL_EXEC_OPTS);
    expect(out).toBe("No browser session to close.");
  });
});
