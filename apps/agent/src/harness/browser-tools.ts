/**
 * Browser tools backed by Cloudflare Browser Rendering binding + @cloudflare/playwright.
 *
 * Lifecycle: one Page per SessionDO, lazy-created on first browser_* tool call,
 * destroyed on session destroy. The Browser stays connected across turns within
 * the session (keep_alive: 600s — max). If the DO hibernates, the in-memory
 * handle is lost; next call relaunches (fresh page, agents re-navigate).
 *
 * Tools mirror Playwright's locator-based API but stay coarse so the LLM
 * doesn't have to think about implementation details.
 *
 * Hybrid-billing hook: createBrowserSession optionally accepts a
 * BillingHook { tenantId, sessionId, agentId?, onClose } — invoked once
 * on close() with the Page-open elapsed seconds. SessionDO wires the
 * onClose callback to UsageStore.recordUsage(kind=browser_active_seconds).
 */
import { z } from "zod";
import { tool } from "ai";
import { launch } from "@cloudflare/playwright";
import type { Browser, Page, BrowserWorker } from "@cloudflare/playwright";

export interface BrowserSession {
  /** Get or create the singleton Page for this session. */
  page(): Promise<Page>;
  /** Tear down the browser session. Idempotent. */
  close(): Promise<void>;
  /** True if the page has been created (avoids surfacing browser_close as no-op). */
  isOpen(): boolean;
}

/**
 * Hook the caller (SessionDO) optionally passes to attribute the
 * browser_active_seconds emit. Pure data shape — no SDK dependency in
 * this module.
 */
export interface BrowserBillingHook {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  /** Called once on close() with elapsed wall-clock seconds (Page-open → close). */
  onClose: (elapsedSeconds: number) => Promise<void> | void;
}

/**
 * Holds one Browser+Page across the session's lifetime. In-memory only —
 * recreated if the DO hibernates.
 *
 * `hook` is optional so unit tests / non-billing call sites pass null
 * and get the original behavior.
 */
export function createBrowserSession(
  binding: BrowserWorker,
  hook?: BrowserBillingHook | null,
): BrowserSession {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let openedAtMs: number | null = null;

  async function ensure(): Promise<Page> {
    if (page) return page;
    // keep_alive: 600s = max. Session persists 10 min idle after disconnect.
    browser = await launch(binding, { keep_alive: 600_000 });
    const context = await browser.newContext();
    page = await context.newPage();
    openedAtMs = Date.now();
    return page;
  }

  return {
    page: ensure,
    isOpen: () => page !== null,
    async close() {
      const wasOpen = page !== null && openedAtMs !== null;
      const elapsedMs = wasOpen ? Date.now() - (openedAtMs as number) : 0;
      try {
        if (browser) await browser.close();
      } catch {}
      browser = null;
      page = null;
      openedAtMs = null;
      // Emit billing AFTER browser teardown so a slow close() doesn't
      // delay the cleanup (and so close() failure paths still record
      // the elapsed time the user got value from).
      if (wasOpen && hook) {
        const seconds = Math.floor(elapsedMs / 1000);
        if (seconds > 0) {
          try {
            await hook.onClose(seconds);
          } catch (err) {
            console.error(
              `[browser-tools] billing hook failed: ${(err as Error)?.message ?? err}`,
            );
          }
        }
      }
    },
  };
}

const DEFAULT_TIMEOUT = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolSet = Record<string, any>;

/**
 * Add browser_* tools to the agent's tool set. No-op if no binding is configured.
 *
 * Returned tool names: browser_navigate, browser_screenshot, browser_click,
 * browser_type, browser_get_text, browser_eval, browser_close.
 */
export function buildBrowserTools(session: BrowserSession | null): ToolSet {
  if (!session) return {};

  const tools: ToolSet = {};

  tools.browser_navigate = tool({
    description:
      "Navigate the browser to a URL and wait for the page to load (network idle, " +
      "30s timeout). Returns the final URL after redirects.",
    inputSchema: z.object({
      url: z.string().describe("Absolute URL, e.g. https://example.com/path"),
    }),
    execute: async ({ url }) => {
      const page = await session.page();
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        const finalUrl = page.url();
        const status = response?.status();
        return `Loaded ${finalUrl} (HTTP ${status ?? "?"})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Navigate error: ${msg}`;
      }
    },
  });

  tools.browser_screenshot = tool({
    description:
      "Capture a PNG screenshot of the current page (visible viewport). Returns " +
      "the image so you can read text, layout, charts, etc. directly. Use this " +
      "when text extraction (browser_get_text) isn't enough — e.g. images, PDFs " +
      "rendered in browser, charts, complex layout.",
    inputSchema: z.object({
      full_page: z.boolean().optional().describe("If true, capture the entire scrollable page (slower)."),
    }),
    execute: async ({ full_page }) => {
      const page = await session.page();
      try {
        const buf = await page.screenshot({ fullPage: full_page === true, type: "png" });
        // Buffer (returned by Playwright) → base64 string. Buffer is available in
        // Workers via nodejs_compat.
        const data = (buf as unknown as { toString: (enc: string) => string }).toString("base64");
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Screenshot error: ${msg}`;
      }
    },
    // Mirror Read tool's multimodal hook so the screenshot reaches Claude as
    // image content rather than a stringified blob.
    toModelOutput: ({ output }: { output: unknown }) => {
      if (output && typeof output === "object" && "type" in output && (output as { type?: string }).type === "image") {
        const src = (output as unknown as { source: { data: string; media_type: string } }).source;
        return {
          type: "content" as const,
          value: [{ type: "file-data" as const, data: src.data, mediaType: src.media_type }],
        };
      }
      return { type: "text" as const, value: typeof output === "string" ? output : JSON.stringify(output) };
    },
  });

  tools.browser_click = tool({
    description:
      "Click an element matched by a CSS selector or text. Auto-waits up to 30s. " +
      "Examples: 'button[type=submit]', 'a:has-text(\"Sign in\")', '#submit'.",
    inputSchema: z.object({
      selector: z.string().describe("Playwright selector (CSS, :has-text, etc.)"),
    }),
    execute: async ({ selector }) => {
      const page = await session.page();
      try {
        await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
        return `Clicked: ${selector}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Click error: ${msg}`;
      }
    },
  });

  tools.browser_type = tool({
    description:
      "Type text into an input/textarea matched by a selector. Clears existing " +
      "value first. Use submit:true to press Enter after typing.",
    inputSchema: z.object({
      selector: z.string().describe("Playwright selector for the input/textarea"),
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing (default false)"),
    }),
    execute: async ({ selector, text, submit }) => {
      const page = await session.page();
      try {
        const locator = page.locator(selector).first();
        await locator.fill(text, { timeout: DEFAULT_TIMEOUT });
        if (submit) await locator.press("Enter");
        return `Typed ${text.length} chars into: ${selector}${submit ? " (submitted)" : ""}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Type error: ${msg}`;
      }
    },
  });

  tools.browser_get_text = tool({
    description:
      "Extract visible text from the page. Without selector returns the whole " +
      "<body> innerText (may be long — truncated to 30k chars). With selector " +
      "returns text from matching element.",
    inputSchema: z.object({
      selector: z.string().optional().describe("Optional Playwright selector to scope extraction"),
      max_chars: z.number().optional().describe("Truncation limit (default 30000)"),
    }),
    execute: async ({ selector, max_chars }) => {
      const page = await session.page();
      try {
        const text = selector
          ? await page.locator(selector).first().innerText({ timeout: DEFAULT_TIMEOUT })
          : await page.locator("body").innerText({ timeout: DEFAULT_TIMEOUT });
        const limit = max_chars ?? 30_000;
        if (text.length > limit) {
          return text.slice(0, limit) + `\n\n...[truncated; ${text.length - limit} more chars]`;
        }
        return text || "(empty)";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Get text error: ${msg}`;
      }
    },
  });

  tools.browser_eval = tool({
    description:
      "Run a JavaScript expression in the page context. Returns the JSON-stringified " +
      "result. Use for fetching computed properties, hidden state, or DOM queries the " +
      "other tools can't reach. Example: 'document.querySelectorAll(\"a\").length'.",
    inputSchema: z.object({
      expression: z.string().describe("JavaScript expression (sync or async). Result is serialized to JSON."),
    }),
    execute: async ({ expression }) => {
      const page = await session.page();
      try {
        // Wrap as an arrow returning the eval'd expression. Strings are valid
        // PageFunctions in Playwright, but the typed signature wants a function;
        // cast to `any` to use the string overload directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (page.evaluate as any)(expression);
        return JSON.stringify(result, null, 2).slice(0, 30_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Eval error: ${msg}`;
      }
    },
  });

  tools.browser_close = tool({
    description:
      "Close the browser session. Use only when you're truly done — subsequent " +
      "browser_* calls will spin up a fresh session (loses cookies/state).",
    inputSchema: z.object({}),
    execute: async () => {
      if (!session.isOpen()) return "No browser session to close.";
      await session.close();
      return "Browser session closed.";
    },
  });

  return tools;
}
