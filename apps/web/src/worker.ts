// Tiny shim that fronts the static Astro build:
//   - www.openma.dev → 301 → openma.dev (apex is canonical)
//   - everything else: pass through to env.ASSETS
// Without this the worker would just be a pure-static `assets:` deploy
// and CF custom-domain rules can't do hostname-level redirects on
// their own. Worker code costs us nothing — assets short-circuit before
// any JS runs for cache hits.

interface Env {
  ASSETS: { fetch: typeof fetch };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "www.openma.dev" || url.hostname === "www.staging.openma.dev") {
      url.hostname = url.hostname.replace(/^www\./, "");
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
