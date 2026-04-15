import { test, expect, type Page } from "@playwright/test";

/**
 * E2E test for openma console.
 *
 * Prerequisites:
 *   - wrangler dev running on :8787 (backend)
 *   - vite dev running on :5173 (frontend) OR playwright.config starts it
 *   - D1 migration applied (tables exist)
 *
 * Run:
 *   npx playwright test test/e2e/console.spec.ts
 */

const TEST_EMAIL = `e2e-${Date.now()}@test.openma.dev`;
const TEST_PASSWORD = "e2e-testpass-123";
const TEST_NAME = "E2E Tester";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

async function signup(page: Page) {
  await page.goto("/");
  await page.waitForURL("**/login");

  // Switch to signup
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  // Fill form
  await page.getByPlaceholder("Your name").fill(TEST_NAME);
  await page.getByPlaceholder("you@example.com").fill(TEST_EMAIL);
  await page.getByPlaceholder("Min 8 characters").fill(TEST_PASSWORD);

  // Submit
  await page.getByRole("button", { name: "Create account" }).click();

  // Should redirect to dashboard
  await page.waitForURL("**/", { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Quickstart" })).toBeVisible();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(TEST_EMAIL);
  await page.getByPlaceholder("Min 8 characters").fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/", { timeout: 10_000 });
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

test.describe.serial("Console E2E", () => {
  test("1. unauthenticated user is redirected to /login", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL("**/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("2. signup creates account and redirects to dashboard", async ({ page }) => {
    await signup(page);

    // User info visible in sidebar
    await expect(page.getByText(TEST_NAME)).toBeVisible();
    await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  });

  test("3. logout returns to login page", async ({ page }) => {
    await signup(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login", { timeout: 5_000 });
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });

  test("4. login with existing account", async ({ page }) => {
    // First signup
    await signup(page);
    // Logout
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/login");
    // Login
    await login(page);
    await expect(page.getByRole("heading", { name: "Quickstart" })).toBeVisible();
  });

  test("5. forgot password flow shows confirmation", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();

    await page.getByPlaceholder("you@example.com").fill("nobody@test.com");
    await page.getByRole("button", { name: "Send reset link" }).click();

    await expect(page.getByText("Check your email")).toBeVisible({ timeout: 5_000 });
  });

  test("6. API Keys page — create and revoke", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "API Keys" }).click();
    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible();

    // Create key
    await page.getByRole("button", { name: "+ New API key" }).click();
    await page.getByPlaceholder("e.g. CLI key, CI/CD").fill("Test E2E Key");
    await page.getByRole("button", { name: "Create" }).click();

    // Should show the key once
    await expect(page.getByText("API Key Created")).toBeVisible();
    await expect(page.getByText("oma_")).toBeVisible();

    // Close dialog
    await page.getByRole("button", { name: "Done" }).click();

    // Key should appear in the table
    await expect(page.getByText("Test E2E Key")).toBeVisible();

    // Revoke
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("No API keys yet")).toBeVisible({ timeout: 5_000 });
  });

  test("7. Model Cards page — create with provider selection", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Model Cards" }).click();
    await expect(page.getByRole("heading", { name: "Model Cards" })).toBeVisible();

    // Open create dialog
    await page.getByRole("button", { name: "+ New model card" }).click();
    await expect(page.getByText("API Format")).toBeVisible();

    // Select OpenAI-compatible
    await page.getByText("OpenAI-compatible").click();

    // Fill form
    await page.getByPlaceholder("My API Key").fill("DeepSeek Chat");
    await page.getByPlaceholder("sk-...").fill("sk-test-fake-key-12345678");
    await page.locator("input[name='model-id-field']").fill("deepseek-chat");
    await page.getByPlaceholder(/your-proxy|deepseek/).fill("https://api.deepseek.com/v1");

    // Create
    await page.getByRole("button", { name: "Create" }).click();

    // Should appear in table
    await expect(page.getByText("DeepSeek Chat")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("deepseek-chat")).toBeVisible();
  });

  test("8. Skills page — ClawHub search", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Skills" }).click();
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();

    // Open ClawHub dialog
    await page.getByRole("button", { name: "ClawHub" }).click();
    await expect(page.getByText("Install from ClawHub")).toBeVisible();

    // Search
    await page.getByPlaceholder(/Search skills/).fill("nextjs");
    await page.getByRole("button", { name: "Search" }).click();

    // Should show results
    await expect(page.getByRole("button", { name: "Install" }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("9. Navigation — all sidebar links work", async ({ page }) => {
    await signup(page);

    const links = [
      { name: "Agents", heading: "Agents" },
      { name: "Sessions", heading: "Sessions" },
      { name: "Environments", heading: "Environments" },
      { name: "Credential Vaults", heading: "Credential Vaults" },
      { name: "Skills", heading: "Skills" },
      { name: "Memory Stores", heading: "Memory Stores" },
      { name: "Model Cards", heading: "Model Cards" },
      { name: "API Keys", heading: "API Keys" },
    ];

    for (const link of links) {
      await page.getByRole("link", { name: link.name }).click();
      await expect(page.getByRole("heading", { name: link.heading })).toBeVisible({ timeout: 3_000 });
    }
  });

  test("10. Custom headers shown only for compatible providers", async ({ page }) => {
    await signup(page);
    await page.getByRole("link", { name: "Model Cards" }).click();
    await page.getByRole("button", { name: "+ New model card" }).click();

    // Anthropic (official) — no Base URL or Custom Headers
    await expect(page.getByText("Custom Headers")).not.toBeVisible();
    await expect(page.getByText("Base URL")).not.toBeVisible();

    // Switch to OpenAI-compatible — should show Base URL and Custom Headers
    await page.getByText("OpenAI-compatible").click();
    await expect(page.getByText("Base URL")).toBeVisible();
    await expect(page.getByText("Custom Headers")).toBeVisible();

    // Switch back to OpenAI (official) — should hide again
    await page.getByText("OpenAI").first().click();
    await expect(page.getByText("Custom Headers")).not.toBeVisible();
  });
});
