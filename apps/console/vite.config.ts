import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
