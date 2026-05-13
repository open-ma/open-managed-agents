/**
 * CF SessionDO browser entry — thin re-export over @open-managed-agents/
 * browser-harness so the workerd binding details (env.BROWSER) live in
 * the package, not in the harness.
 *
 * The agent harness's tools.ts depends on the package directly; this
 * file is kept only because apps/agent/src/runtime/session-do.ts has
 * historically imported `createBrowserSession` from here. Those callers
 * keep working without any wire-shape change — only the implementation
 * moved.
 */
export {
  createBrowserSession,
  createCfBrowserHarness,
  type CfBrowserBinding,
} from "@open-managed-agents/browser-harness/cf";
export {
  buildBrowserTools,
  NotSupportedError,
  type BrowserHarness,
  type BrowserSession,
  type BrowserBillingHook,
  type BrowserSessionOpts,
  type BrowserPage,
} from "@open-managed-agents/browser-harness";
