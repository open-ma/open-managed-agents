// @open-managed-agents/browser-harness — runtime-agnostic browser tool surface.
//
// Three impls live in sibling files:
//   - cf.ts      → wraps @cloudflare/playwright + the BROWSER binding
//   - node.ts    → wraps playwright-core's chromium.launch() (lazy import)
//   - cdp.ts     → wraps playwright-core's chromium.connect() to a remote
//                  Browserless / k8s pool (BROWSERLESS_URL)
//   - disabled.ts → throw-on-call placeholder when nothing else is wired
//
// The agent harness consumes ONLY the BrowserHarness + BrowserSession
// interfaces from this file; no Playwright type leaks into apps/agent.

import { z } from "zod";
import { tool } from "ai";

/** Subset of Playwright Page methods the harness uses. Typed loosely so
 *  the package doesn't have to depend on @cloudflare/playwright or
 *  playwright-core directly — both shapes satisfy this interface. */
export interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<{ status?(): number } | null>;
  url(): string;
  screenshot(opts?: { fullPage?: boolean; type?: "png" | "jpeg" }): Promise<Uint8Array | { toString(enc: string): string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  locator(selector: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate(expr: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<any>;
  content(): Promise<string>;
}

/** One Browser+Page wrapper, lazy-launched on first page() call. */
export interface BrowserSession {
  page(): Promise<BrowserPage>;
  close(): Promise<void>;
  isOpen(): boolean;
}

/** Optional billing hook — fired once on close() with the elapsed
 *  page-open seconds. CF SessionDO wires this to UsageStore.recordUsage. */
export interface BrowserBillingHook {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  onClose: (elapsedSeconds: number) => Promise<void> | void;
}

export interface BrowserSessionOpts {
  hook?: BrowserBillingHook | null;
}

/** Factory for BrowserSession. CF / Node / CDP / Disabled implement this. */
export interface BrowserHarness {
  launch(opts?: BrowserSessionOpts): Promise<BrowserSession>;
}

/** Thrown by the Disabled impl when an agent calls a browser_* tool but
 *  no backend is configured. Wrapped as a tool-result string so the LLM
 *  sees the message and can fall back to web_fetch. */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

const DEFAULT_TIMEOUT = 30_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolSet = Record<string, any>;

/**
 * Add browser_* tools to the agent's tool set. No-op when harness is null.
 *
 * Returned tool names: browser_navigate, browser_screenshot, browser_click,
 * browser_type, browser_get_text, browser_eval, browser_close.
 *
 * The harness is launched lazily on first browser_* tool call and reused
 * across the rest of the build. Within a session Playwright reuses
 * Browser/Context/Page on its own — no pooling layer here.
 */
export function buildBrowserTools(
  harness: BrowserHarness | null,
  hook?: BrowserBillingHook | null,
): ToolSet {
  if (!harness) return {};
  const h = harness;
  let session: BrowserSession | null = null;
  async function ensureSession(): Promise<BrowserSession> {
    if (session) return session;
    session = await h.launch({ hook });
    return session;
  }
  async function ensurePage(): Promise<BrowserPage> {
    const s = await ensureSession();
    return s.page();
  }

  const tools: ToolSet = {};

  tools.browser_navigate = tool({
    description:
      "Navigate the browser to a URL and wait for the page to load (network idle, " +
      "30s timeout). Returns the final URL after redirects.",
    inputSchema: z.object({
      url: z.string().describe("Absolute URL, e.g. https://example.com/path"),
    }),
    execute: async ({ url }: { url: string }) => {
      try {
        const page = await ensurePage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        const finalUrl = page.url();
        const status = response?.status?.();
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
    execute: async ({ full_page }: { full_page?: boolean }) => {
      try {
        const page = await ensurePage();
        const buf = await page.screenshot({ fullPage: full_page === true, type: "png" });
        const data = bufferToBase64(buf);
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Screenshot error: ${msg}`;
      }
    },
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
    execute: async ({ selector }: { selector: string }) => {
      try {
        const page = await ensurePage();
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
    execute: async ({ selector, text, submit }: { selector: string; text: string; submit?: boolean }) => {
      try {
        const page = await ensurePage();
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
    execute: async ({ selector, max_chars }: { selector?: string; max_chars?: number }) => {
      try {
        const page = await ensurePage();
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
    execute: async ({ expression }: { expression: string }) => {
      try {
        const page = await ensurePage();
        // String overload of Playwright's evaluate isn't in the typed
        // signature — cast to call it directly.
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
      if (!session || !session.isOpen()) return "No browser session to close.";
      await session.close();
      session = null;
      return "Browser session closed.";
    },
  });

  return tools;
}

/** Playwright Page.screenshot returns Buffer on Node and Uint8Array on
 *  workerd; both convert to base64 below. Node's Buffer has toString,
 *  Uint8Array we wrap in btoa. */
function bufferToBase64(buf: Uint8Array | { toString(enc: string): string }): string {
  if (typeof (buf as { toString?: unknown }).toString === "function" && "byteLength" in (buf as object) === false) {
    return (buf as { toString: (enc: string) => string }).toString("base64");
  }
  if (buf instanceof Uint8Array) {
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
    return btoa(binary);
  }
  return (buf as { toString: (enc: string) => string }).toString("base64");
}
