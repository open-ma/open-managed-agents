// Throw-on-call BrowserHarness — the default when no other backend is
// wired (no CF binding, no playwright-core peer, no BROWSERLESS_URL).
//
// We still return a BrowserHarness so the agent-harness wiring stays
// uniform; the throw lands at launch() time, surfaced to the LLM as a
// tool-result string by the buildBrowserTools wrapper. This is the
// single explicit "browser tool not configured" message operators see.

import { NotSupportedError } from "./index";
import type {
  BrowserHarness,
  BrowserSession,
} from "./index";

export const DEFAULT_DISABLED_MESSAGE =
  "browser tool requires playwright-core to be installed in main-node, " +
  "or BROWSERLESS_URL to point at a remote pool";

export function createDisabledBrowserHarness(message = DEFAULT_DISABLED_MESSAGE): BrowserHarness {
  return {
    async launch(): Promise<BrowserSession> {
      throw new NotSupportedError(message);
    },
  };
}
