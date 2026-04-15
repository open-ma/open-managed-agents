import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm run dev:console",
    port: 5173,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
