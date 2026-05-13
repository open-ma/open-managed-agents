// Env-driven dispatch helper used by apps/main-node to pick a
// BrowserHarness implementation at boot.
//
// Order:
//   1. BROWSERLESS_URL (or BROWSER_REMOTE_URL) → CDP impl. CDP doesn't
//      need a local chromium binary, so this wins regardless of whether
//      playwright-core resolves locally; the lazy import happens at
//      launch() time and surfaces a clear error if the peer is missing.
//   2. playwright-core resolvable OR BROWSER_EXECUTABLE_PATH set →
//      Node impl (chromium.launch()).
//   3. Otherwise → Disabled. Throws on every browser_* tool call with
//      the install-instructions message documented in disabled.ts.
//
// The factory is sync from the caller's POV: we only return *which* impl
// to use plus its constructor opts. main-node then calls the matching
// createXxxBrowserHarness() — the actual playwright-core import is
// deferred to first launch().

import type { BrowserHarness } from "./index";

export type SelectedKind = "cdp" | "node" | "disabled";

export interface SelectInput {
  env: {
    BROWSERLESS_URL?: string;
    BROWSER_REMOTE_URL?: string;
    BROWSER_EXECUTABLE_PATH?: string;
  };
  /** Caller-supplied resolver — main-node passes a fn that does
   *  `require.resolve("playwright-core")` (in CJS) or `import.meta`
   *  resolution. Tests pass a stub. */
  hasPlaywrightCore: () => boolean;
}

export interface SelectResult {
  kind: SelectedKind;
  /** Only set when kind="cdp". */
  url?: string;
  /** Only set when kind="node" and BROWSER_EXECUTABLE_PATH is present. */
  executablePath?: string;
}

export async function selectBrowserHarness(input: SelectInput): Promise<SelectResult> {
  const remote = input.env.BROWSERLESS_URL ?? input.env.BROWSER_REMOTE_URL;
  if (remote) return { kind: "cdp", url: remote };

  const execPath = input.env.BROWSER_EXECUTABLE_PATH;
  if (execPath) return { kind: "node", executablePath: execPath };

  if (input.hasPlaywrightCore()) return { kind: "node" };

  return { kind: "disabled" };
}

/** Materialise the selected impl. Lazy-imports the matching adapter so
 *  Node-only adapters never load on workerd and vice-versa. */
export async function buildSelectedBrowserHarness(sel: SelectResult): Promise<BrowserHarness> {
  if (sel.kind === "cdp") {
    const { createCdpBrowserHarness } = await import("./cdp");
    return createCdpBrowserHarness({ url: sel.url! });
  }
  if (sel.kind === "node") {
    const { createNodeBrowserHarness } = await import("./node");
    return createNodeBrowserHarness(
      sel.executablePath ? { executablePath: sel.executablePath } : undefined,
    );
  }
  const { createDisabledBrowserHarness } = await import("./disabled");
  return createDisabledBrowserHarness();
}
