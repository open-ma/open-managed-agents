/**
 * Single source of truth for the daemon's version string.
 *
 * tsup chunks may live one or two levels deep relative to package.json
 * after bundling, so we try both paths. Final fallback is "0.0.0-dev"
 * — only ever shown if running from source via tsx without tsup.
 */
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

export const PKG_VERSION: string = (() => {
  for (const path of ["../package.json", "../../package.json"]) {
    try { return (req(path) as { version: string }).version; } catch { /* try next */ }
  }
  return "0.0.0-dev";
})();
