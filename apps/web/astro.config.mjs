// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  // Apex is canonical. The worker (src/worker.ts) 301-redirects
  // www→apex, so canonical/og:url/sitemap entries must point at apex
  // — otherwise every link Google indexes resolves through a 301.
  site: "https://openma.dev",
  trailingSlash: "always",
  integrations: [
    sitemap({
      // Per-route priority + changefreq hints. Google ignores priority
      // mostly but Bing + smaller crawlers use them.
      serialize(item) {
        const url = new URL(item.url);
        if (url.pathname === "/") {
          item.priority = 1.0;
          item.changefreq = "weekly";
        } else if (url.pathname === "/blog/") {
          item.priority = 0.9;
          item.changefreq = "weekly";
        } else if (url.pathname.startsWith("/blog/")) {
          item.priority = 0.7;
          item.changefreq = "monthly";
        } else {
          item.priority = 0.5;
        }
        return item;
      },
      // RSS already covers the blog discovery channel; sitemap covers
      // the rest of the site.
      filter: (page) => !page.endsWith("/rss.xml"),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  output: "static",
  build: {
    format: "directory",
  },
});
