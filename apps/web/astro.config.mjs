// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  site: "https://openma.dev",
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  output: "static",
  build: {
    format: "directory", // /blog/foo/index.html — clean URLs
  },
});
