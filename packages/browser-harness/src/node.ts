// Node-Playwright adapter.
//
// Lazy-imports playwright-core (peer dep) and launches headless chromium.
// Operators must either install chromium via `pnpm exec playwright install
// chromium` or set BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser to
// point at distro-shipped chromium.

import type {
  BrowserHarness,
  BrowserSession,
  BrowserSessionOpts,
  BrowserPage,
} from "./index";

export interface NodeBrowserHarnessOpts {
  /** Override the chromium binary path (e.g. /usr/bin/chromium-browser).
   *  Defaults to playwright-core's bundled chromium under ~/.cache/ms-playwright. */
  executablePath?: string;
  /** Headless mode. Defaults to true; flip to false for local debugging. */
  headless?: boolean;
}

export function createNodeBrowserHarness(
  opts?: NodeBrowserHarnessOpts,
): BrowserHarness {
  return {
    async launch(launchOpts?: BrowserSessionOpts): Promise<BrowserSession> {
      return createNodeBrowserSession(opts ?? {}, launchOpts?.hook ?? null);
    },
  };
}

function createNodeBrowserSession(
  opts: NodeBrowserHarnessOpts,
  hook: BrowserSessionOpts["hook"] | null | undefined,
): BrowserSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  let page: BrowserPage | null = null;
  let openedAtMs: number | null = null;

  async function ensure(): Promise<BrowserPage> {
    if (page) return page;
    // Function-wrapped dynamic import keeps TS off our back — playwright-core
    // is an optional peer; without it, the dispatcher should pick a
    // different impl and this code path is unreachable.
    const importer = Function("p", "return import(p)") as (
      p: string,
    ) => Promise<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chromium: { launch: (opts: { headless?: boolean; executablePath?: string }) => Promise<any> };
    }>;
    const pw = await importer("playwright-core");
    browser = await pw.chromium.launch({
      headless: opts.headless ?? true,
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    });
    const context = await browser.newContext();
    page = (await context.newPage()) as BrowserPage;
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
      if (wasOpen && hook) {
        const seconds = Math.floor(elapsedMs / 1000);
        if (seconds > 0) {
          try {
            await hook.onClose(seconds);
          } catch (err) {
            console.error(
              `[browser-harness/node] billing hook failed: ${(err as Error)?.message ?? err}`,
            );
          }
        }
      }
    },
  };
}
