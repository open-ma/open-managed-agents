import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:8787";

// Shared proxy config. cookieDomainRewrite makes Set-Cookie headers from
// any non-localhost API target (staging / prod) land on localhost so
// browser-side auth works through the dev proxy.
const proxyOpts = {
  target: API_TARGET,
  changeOrigin: true,
  secure: true,
  cookieDomainRewrite: "localhost",
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@/registry/default/ui": path.resolve(__dirname, "./src/components/ui"),
      "@/registry/default/blocks": path.resolve(__dirname, "./src/components/blocks"),
      "@/registry/default/hooks": path.resolve(__dirname, "./src/hooks"),
      "@/registry/default/lib": path.resolve(__dirname, "./src/lib"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": proxyOpts,
      "/auth": proxyOpts,
      "/auth-info": proxyOpts,
      "/health": proxyOpts,
      "/linear": proxyOpts,
      "/linear-setup": proxyOpts,
      "/github": proxyOpts,
      "/github-setup": proxyOpts,
    },
  },
});
