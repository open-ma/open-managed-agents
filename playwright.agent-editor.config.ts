import { defineConfig } from "@playwright/test";

const browserExecutable = process.env.OMA_E2E_BROWSER_EXECUTABLE;

/**
 * Isolated, keyless Console contract lane. A dedicated strict port prevents
 * Playwright from silently reusing an unrelated developer server on :5173.
 */
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4177",
    headless: true,
    launchOptions: browserExecutable
      ? { executablePath: browserExecutable }
      : undefined,
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter managed-agents-console exec vite --host 127.0.0.1 --port 4177 --strictPort",
    port: 4177,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
