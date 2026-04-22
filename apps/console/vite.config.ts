import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1":         { target: API_TARGET, changeOrigin: true, secure: true },
      "/auth":       { target: API_TARGET, changeOrigin: true, secure: true },
      "/auth-info":  { target: API_TARGET, changeOrigin: true, secure: true },
      "/health":     { target: API_TARGET, changeOrigin: true, secure: true },
      "/linear":     { target: API_TARGET, changeOrigin: true, secure: true },
      "/linear-setup": { target: API_TARGET, changeOrigin: true, secure: true },
      "/github":     { target: API_TARGET, changeOrigin: true, secure: true },
      "/github-setup": { target: API_TARGET, changeOrigin: true, secure: true },
    },
  },
});
