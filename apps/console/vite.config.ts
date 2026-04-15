import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/auth-info": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
