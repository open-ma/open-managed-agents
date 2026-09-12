import { expect, test } from "@playwright/test";
import Anthropic from "@anthropic-ai/sdk";

const deployedBaseURL = process.env.OMA_E2E_BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.OMA_E2E_API_KEY;
const turnModel = process.env.OMA_E2E_MODEL;
const mockModelBaseURL = process.env.OMA_E2E_MOCK_MODEL_BASE_URL?.replace(/\/$/, "");

test.describe("deployed Console smoke", () => {
  test.skip(!deployedBaseURL, "OMA_E2E_BASE_URL is required for deployed smoke");

  test("serves the app and boots without browser errors", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const response = await page.goto(`${deployedBaseURL}/login`, {
      waitUntil: "networkidle",
    });
    expect(response?.status()).toBe(200);
    await expect(page.locator("#root")).not.toBeEmpty();
    await page.getByRole("button", { name: "Continue with email" }).click();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("keeps API routes on the Worker instead of SPA fallback", async ({ request }) => {
    const response = await request.get(`${deployedBaseURL}/health`);
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok" });
  });

  test("round-trips a Managed Agent and Session through the Console", async ({ page }) => {
    test.skip(
      !apiKey || (!turnModel && !mockModelBaseURL),
      "OMA_E2E_API_KEY plus OMA_E2E_MODEL or OMA_E2E_MOCK_MODEL_BASE_URL are required",
    );
    test.setTimeout(120_000);

    const client = new Anthropic({
      apiKey: apiKey!,
      baseURL: deployedBaseURL!,
      maxRetries: 0,
      timeout: 60_000,
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let environment: { id: string } | undefined;
    let agent: { id: string; version: number } | undefined;
    let session: { id: string } | undefined;
    let modelCard: { id: string; model_id: string } | undefined;
    const pageErrors: string[] = [];
    const apiFailures: Array<{ method: string; path: string; status: number }> = [];
    const cleanupErrors: unknown[] = [];

    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (
        url.origin === new URL(deployedBaseURL!).origin &&
        url.pathname.startsWith("/v1/") &&
        response.status() >= 400
      ) {
        apiFailures.push({
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        });
      }
    });

    try {
      if (mockModelBaseURL) {
        const response = await fetch(`${deployedBaseURL}/v1/oma/model_cards`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey! },
          body: JSON.stringify({
            model_id: `console-e2e-mock-${suffix}`,
            model: "openma-e2e-mock",
            provider: "ant-compatible",
            api_key: "openma-e2e-mock-key",
            base_url: mockModelBaseURL,
          }),
        });
        const responseBody = await response.text();
        expect(response.status, responseBody).toBe(201);
        modelCard = JSON.parse(responseBody) as { id: string; model_id: string; probe?: unknown };
        expect(modelCard).toMatchObject({ probe: { ok: true } });
      }
      environment = await client.beta.environments.create({
        name: `console-e2e-environment-${suffix}`,
        scope: "organization",
        config: {
          type: "cloud",
          networking: { type: "unrestricted" },
          packages: { type: "packages" },
        },
      });
      agent = await client.beta.agents.create({
        name: `console-e2e-agent-${suffix}`,
        description: "Created through the official SDK",
        model: modelCard?.model_id ?? turnModel!,
        system: "Follow the user's exact response-format instruction.",
      });
      session = await client.beta.sessions.create({
        agent: { type: "agent", id: agent.id, version: agent.version },
        environment_id: environment.id,
        title: `console-e2e-session-${suffix}`,
      });

      // The test owns an API key rather than a browser login cookie. Mock only
      // Better Auth's session probe so AppShell renders; every product/API/SSE
      // request still hits the deployed Worker with the real API key.
      await page.route("**/auth/get-session**", async (route) => {
        const now = new Date();
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            session: {
              id: "console-e2e-browser-session",
              token: "console-e2e-browser-token",
              userId: "console-e2e-user",
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + 60_000).toISOString(),
            },
            user: {
              id: "console-e2e-user",
              name: "Console E2E",
              email: "console-e2e@openma.test",
              emailVerified: true,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            },
          }),
        });
      });
      await page.route("**/v1/**", async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            "x-api-key": apiKey!,
          },
        });
      });

      await page.goto(`${deployedBaseURL}/agents/${agent.id}`, {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { level: 1, name: `console-e2e-agent-${suffix}` }),
      ).toBeVisible();
      await expect(page.getByText("Created through the official SDK", { exact: true }))
        .toBeVisible();

      await page.getByRole("button", { name: "Edit" }).click();
      const editedDescription = `Edited through the Console ${suffix}`;
      await page.getByLabel("Description").fill(editedDescription);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(editedDescription, { exact: true })).toBeVisible();
      const updatedAgent = await client.beta.agents.retrieve(agent.id);
      expect(updatedAgent.description).toBe(editedDescription);
      agent = { id: updatedAgent.id, version: updatedAgent.version };

      await page.goto(`${deployedBaseURL}/sessions/${session.id}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        page.getByRole("heading", { level: 2, name: `console-e2e-session-${suffix}` }),
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Files", exact: true }).click();
      await expect(page.getByText("Session outputs", { exact: true })).toBeVisible();
      await expect(page.getByText(/No files yet/)).toBeVisible();

      const composer = page.getByRole("textbox", { name: "Message" });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      const expectedReply = mockModelBaseURL ? "E2E_OK" : "E2E_UI_OK";
      await composer.fill(`Reply exactly ${expectedReply}.`);
      // A freshly-created Managed Session may still be `running` while its
      // environment boots. The same composer intentionally labels the action
      // "Queue message" in that state and "Send message" once idle.
      await page.getByRole("button", { name: /^(Send|Queue) message$/ }).click();
      await expect(page.getByText(expectedReply, { exact: true })).toBeVisible({
        timeout: 90_000,
      });

      expect(pageErrors).toEqual([]);
      expect(apiFailures).toEqual([]);
    } finally {
      if (session) {
        await client.beta.sessions.delete(session.id).catch((error) => cleanupErrors.push(error));
      }
      if (agent) {
        await client.beta.agents.archive(agent.id).catch((error) => cleanupErrors.push(error));
      }
      if (environment) {
        await client.beta.environments.delete(environment.id).catch((error) => cleanupErrors.push(error));
      }
      if (modelCard) {
        await fetch(`${deployedBaseURL}/v1/oma/model_cards/${encodeURIComponent(modelCard.id)}`, {
          method: "DELETE",
          headers: { "x-api-key": apiKey! },
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Model Card cleanup failed: ${response.status} ${await response.text()}`);
          }
        }).catch((error) => cleanupErrors.push(error));
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Console E2E cleanup failed");
      }
    }
  });
});
