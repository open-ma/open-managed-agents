// CF Browser Rendering binding adapter.
//
// Wraps @cloudflare/playwright's launch(env.BROWSER) into a BrowserHarness
// whose launch() returns a lazy BrowserSession. Behavior is unchanged from
// the previous in-app implementation: keep_alive=600s, one Browser/Context/
// Page per session, billing hook fires once on close() with elapsed seconds.
//
// @cloudflare/playwright is workerd-only; this module dynamically imports
// it at launch time so Node consumers can import the package without
// pulling the workerd-bundled binary.

import type {
  BrowserHarness,
  BrowserSession,
  BrowserSessionOpts,
  BrowserPage,
} from "./index";

/** The CF Browser Rendering binding shape. Duck-typed so this module
 *  doesn't depend on workers-types at compile time. */
export interface CfBrowserBinding {
  fetch: typeof fetch;
}

export function createCfBrowserHarness(binding: CfBrowserBinding): BrowserHarness {
  return {
    async launch(opts?: BrowserSessionOpts): Promise<BrowserSession> {
      return createCfBrowserSession(binding, opts?.hook ?? null);
    },
  };
}

/** Backwards-compat: CF SessionDO previously called this directly. New code
 *  should prefer createCfBrowserHarness(binding).launch({ hook }). */
export function createBrowserSession(
  binding: CfBrowserBinding,
  hook?: BrowserSessionOpts["hook"] | null,
): BrowserSession {
  return createCfBrowserSession(binding, hook ?? null);
}

function createCfBrowserSession(
  binding: CfBrowserBinding,
  hook: BrowserSessionOpts["hook"] | null | undefined,
): BrowserSession {
  // Avoid a top-level type-only import of @cloudflare/playwright — it
  // pulls workerd-only types and breaks Node typecheck. We use a loose
  // shape here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  let page: BrowserPage | null = null;
  let openedAtMs: number | null = null;

  async function ensure(): Promise<BrowserPage> {
    if (page) return page;
    const mod = (await import("@cloudflare/playwright")) as unknown as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      launch: (b: CfBrowserBinding, opts?: { keep_alive?: number }) => Promise<any>;
    };
    // keep_alive: 600s = max. Session persists 10 min idle after disconnect.
    browser = await mod.launch(binding, { keep_alive: 600_000 });
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
      // Emit billing AFTER browser teardown so a slow close() doesn't
      // delay cleanup, and so close() failure paths still record the
      // elapsed time the user got value from.
      if (wasOpen && hook) {
        const seconds = Math.floor(elapsedMs / 1000);
        if (seconds > 0) {
          try {
            await hook.onClose(seconds);
          } catch (err) {
            console.error(
              `[browser-harness/cf] billing hook failed: ${(err as Error)?.message ?? err}`,
            );
          }
        }
      }
    },
  };
}
