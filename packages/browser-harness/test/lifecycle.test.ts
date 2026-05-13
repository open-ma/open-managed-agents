import { describe, it, expect } from "vitest";
import {
  buildBrowserTools,
  type BrowserHarness,
  type BrowserSession,
  type BrowserPage,
} from "../src/index";

const TOOL_EXEC_OPTS = {
  toolCallId: "tc_test",
  messages: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abortSignal: undefined as any,
};

interface FakePage extends BrowserPage {
  __navCount: number;
  __evalCalls: string[];
}

function makeFakePage(): FakePage {
  let _url = "about:blank";
  const page: FakePage = {
    __navCount: 0,
    __evalCalls: [],
    async goto(url: string) {
      page.__navCount++;
      _url = url;
      return { status: () => 200 };
    },
    url: () => _url,
    async screenshot() {
      // Single-byte PNG fake — tested for non-empty buffer pass-through.
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    locator: (sel: string) => ({
      first: () => ({
        click: async () => undefined,
        fill: async () => undefined,
        press: async () => undefined,
        innerText: async () => `text for ${sel}`,
      }),
      innerText: async () => "body text",
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evaluate: async (expr: any) => {
      page.__evalCalls.push(String(expr));
      return "Example Domain";
    },
    async content() {
      return "<html></html>";
    },
  };
  return page;
}

function makeFakeHarness(): {
  harness: BrowserHarness;
  __launchCount: () => number;
  __lastPage: () => FakePage | null;
  __closeCount: () => number;
} {
  let launches = 0;
  let closes = 0;
  let lastPage: FakePage | null = null;
  const harness: BrowserHarness = {
    async launch() {
      launches++;
      const page = makeFakePage();
      lastPage = page;
      let opened = true;
      const session: BrowserSession = {
        async page() {
          return page;
        },
        async close() {
          closes++;
          opened = false;
        },
        isOpen: () => opened,
      };
      return session;
    },
  };
  return {
    harness,
    __launchCount: () => launches,
    __lastPage: () => lastPage,
    __closeCount: () => closes,
  };
}

describe("buildBrowserTools session lifecycle", () => {
  it("calls harness.launch() lazily — not at registration", () => {
    const { harness, __launchCount } = makeFakeHarness();
    buildBrowserTools(harness);
    expect(__launchCount()).toBe(0);
  });

  it("first browser_* call launches once; subsequent calls reuse the session", async () => {
    const { harness, __launchCount, __lastPage } = makeFakeHarness();
    const tools = buildBrowserTools(harness);

    await tools.browser_navigate.execute({ url: "https://example.com" }, TOOL_EXEC_OPTS);
    await tools.browser_get_text.execute({}, TOOL_EXEC_OPTS);
    await tools.browser_eval.execute({ expression: "document.title" }, TOOL_EXEC_OPTS);

    expect(__launchCount()).toBe(1);
    expect(__lastPage()?.__navCount).toBe(1);
    expect(__lastPage()?.__evalCalls).toEqual(["document.title"]);
  });

  it("browser_close tears down and the next call relaunches", async () => {
    const { harness, __launchCount, __closeCount } = makeFakeHarness();
    const tools = buildBrowserTools(harness);

    await tools.browser_navigate.execute({ url: "https://a.example" }, TOOL_EXEC_OPTS);
    await tools.browser_close.execute({}, TOOL_EXEC_OPTS);
    expect(__closeCount()).toBe(1);

    await tools.browser_navigate.execute({ url: "https://b.example" }, TOOL_EXEC_OPTS);
    expect(__launchCount()).toBe(2);
  });

  it("browser_screenshot returns a multimodal image block (base64 PNG)", async () => {
    const { harness } = makeFakeHarness();
    const tools = buildBrowserTools(harness);
    const out = await tools.browser_screenshot.execute({}, TOOL_EXEC_OPTS);
    expect(out).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    expect((out as { source: { data: string } }).source.data.length).toBeGreaterThan(0);
  });

  it("browser_navigate returns a status string from the harness page", async () => {
    const { harness } = makeFakeHarness();
    const tools = buildBrowserTools(harness);
    const out = await tools.browser_navigate.execute(
      { url: "https://example.com" },
      TOOL_EXEC_OPTS,
    );
    expect(out).toBe("Loaded https://example.com (HTTP 200)");
  });
});
