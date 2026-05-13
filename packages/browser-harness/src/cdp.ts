// Connect-over-CDP adapter — for Browserless / k8s pool / any remote
// chromium reachable via CDP WebSocket. Triggered by BROWSERLESS_URL (or
// BROWSER_REMOTE_URL) so operators can self-host without bundling chromium.
//
// Single env var to enable. The same playwright-core peer is required —
// chromium.connect() is the only thing we call on it.

import type {
  BrowserHarness,
  BrowserSession,
  BrowserSessionOpts,
  BrowserPage,
} from "./index";

export interface CdpBrowserHarnessOpts {
  /** Full ws:// or wss:// URL to the remote chromium endpoint. */
  url: string;
}

export function createCdpBrowserHarness(opts: CdpBrowserHarnessOpts): BrowserHarness {
  return {
    async launch(launchOpts?: BrowserSessionOpts): Promise<BrowserSession> {
      return createCdpBrowserSession(opts.url, launchOpts?.hook ?? null);
    },
  };
}

function createCdpBrowserSession(
  url: string,
  hook: BrowserSessionOpts["hook"] | null | undefined,
): BrowserSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  let page: BrowserPage | null = null;
  let openedAtMs: number | null = null;

  async function ensure(): Promise<BrowserPage> {
    if (page) return page;
    const importer = Function("p", "return import(p)") as (
      p: string,
    ) => Promise<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chromium: { connect: (url: string) => Promise<any> };
    }>;
    const pw = await importer("playwright-core");
    browser = await pw.chromium.connect(url);
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
              `[browser-harness/cdp] billing hook failed: ${(err as Error)?.message ?? err}`,
            );
          }
        }
      }
    },
  };
}
