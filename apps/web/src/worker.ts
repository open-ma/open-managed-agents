// Tiny shim that fronts the static Astro build:
//   - www.openma.dev/* → 301 → openma.dev/*  (apex is canonical)
//   - openma.dev/{login,sessions,agents,...} → 301 → app.openma.dev/...
//     (old bookmarks from when apex was the Console SPA)
//   - everything else: pass through to env.ASSETS (Astro static)
//
// CF custom-domain rules can't do hostname-level redirects on their own,
// and asset serving short-circuits before the worker unless
// `assets.run_worker_first` is set in wrangler.jsonc.

interface Env {
  ASSETS: { fetch: typeof fetch };
}

// Top-level paths that used to belong to the Console SPA when apex
// was managed-agents. Catches old bookmarks + the few hardcoded
// openma.dev/login links we already patched but might miss.
const CONSOLE_PATH_PREFIXES = [
  "/login",
  "/signup",
  "/sessions",
  "/agents",
  "/environments",
  "/vaults",
  "/dashboard",
  "/billing",
  "/settings",
  "/integrations",
  "/memory",
  "/runtimes",
  "/usage",
];

function isConsolePath(pathname: string): boolean {
  return CONSOLE_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

// www → apex: drop the leading "www." subdomain. Works for both prod
// (www.openma.dev → openma.dev) and staging (www.staging.openma.dev →
// staging.openma.dev). Keeps the path + query intact.
function wwwToApex(url: URL): URL {
  const out = new URL(url.toString());
  out.hostname = out.hostname.replace(/^www\./, "");
  return out;
}

// apex → app: same hostname swap, leading "app." prefix instead.
function apexToApp(url: URL): URL {
  const out = new URL(url.toString());
  out.hostname = `app.${out.hostname}`;
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname.startsWith("www.")) {
      return Response.redirect(wwwToApex(url).toString(), 301);
    }

    if (isConsolePath(url.pathname)) {
      return Response.redirect(apexToApp(url).toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
