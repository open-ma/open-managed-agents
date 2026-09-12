import { expect, test, type Page, type Route } from "@playwright/test";

type JsonObject = Record<string, any>;

const AGENT_ID = "agent_gui_lossless";

function agentFixture(): JsonObject {
  return {
    id: AGENT_ID,
    type: "agent",
    name: "Lossless editor fixture",
    description: "Before edit",
    model: {
      id: "deepseek-main",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: {
        deepseek: { thinking: { type: "disabled" }, cache: "ephemeral" },
      },
    },
    _oma: {
      aux_model: {
        id: "deepseek-aux",
        speed: "fast",
        provider_options: { deepseek: { temperature: 0.2 } },
      },
      appendable_prompts: ["prompt_review", "prompt_security"],
      harness: "pi",
      enable_general_subagent: true,
    },
    system: "Keep every configuration field unless the user edits it.",
    version: 7,
    created_at: "2026-09-12T00:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
    archived_at: null,
    metadata: { owner: "console-e2e", team: "platform" },
    mcp_servers: [
      { name: "docs", type: "url", url: "https://docs.example.test/mcp" },
    ],
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [
          {
            type: "web_fetch",
            name: "web_fetch",
            enabled: true,
            permission_policy: { type: "always_ask" },
            allowed_domains: ["docs.example.test"],
            blocked_domains: ["private.example.test"],
            max_content_tokens: 4096,
          },
        ],
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "docs",
        default_config: {
          enabled: false,
          permission_policy: { type: "always_ask" },
        },
        configs: [{ name: "search", enabled: true }],
      },
      {
        type: "custom",
        name: "deploy",
        description: "Deploy an application",
        input_schema: { type: "object", properties: { target: { type: "string" } } },
      },
    ],
    skills: [
      { type: "anthropic", skill_id: "pdf", version: "2026-09-01" },
      { type: "custom", skill_id: "skill_custom", version: "v3" },
    ],
    multiagent: {
      type: "coordinator",
      agents: [
        { type: "agent", id: "agent_helper", version: 4 },
        { type: "advisor", model: "deepseek-advisor" },
      ],
    },
  };
}

function applyMetadataPatch(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function applyAgentPatch(current: JsonObject, patch: JsonObject): JsonObject {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "version") continue;
    if (key === "metadata") {
      next.metadata = applyMetadataPatch(next.metadata, value);
    } else if (key === "_oma") {
      const extension = { ...(next._oma ?? {}) };
      for (const [extensionKey, extensionValue] of Object.entries(value ?? {})) {
        if (extensionValue === null) delete extension[extensionKey];
        else extension[extensionKey] = structuredClone(extensionValue);
      }
      next._oma = extension;
    } else if (value === null && ["mcp_servers", "skills", "tools"].includes(key)) {
      next[key] = [];
    } else {
      next[key] = structuredClone(value);
    }
  }
  next.version += 1;
  next.updated_at = "2026-09-12T00:01:00.000Z";
  return next;
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function installConsoleFixture(page: Page) {
  let agent = agentFixture();
  const updates: JsonObject[] = [];

  await page.route("**/auth/get-session**", async (route) => {
    const now = new Date();
    await fulfillJson(route, {
      session: {
        id: "session_console_e2e",
        token: "browser-only-test-token",
        userId: "user_console_e2e",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
      user: {
        id: "user_console_e2e",
        name: "Console E2E",
        email: "console-e2e@openma.test",
        emailVerified: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    });
  });

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === `/v1/agents/${AGENT_ID}`) {
      if (request.method() === "POST") {
        const patch = request.postDataJSON() as JsonObject;
        updates.push(structuredClone(patch));
        agent = applyAgentPatch(agent, patch);
      }
      await fulfillJson(route, agent);
      return;
    }
    if (path === `/v1/agents/${AGENT_ID}/versions`) {
      await fulfillJson(route, { data: [agent], next_page: null });
      return;
    }
    if (path === "/v1/agents") {
      await fulfillJson(route, {
        data: [
          agent,
          {
            ...agentFixture(),
            id: "agent_helper",
            name: "Helper",
            version: 4,
            multiagent: null,
          },
        ],
        next_page: null,
      });
      return;
    }
    if (path === "/v1/oma/model_cards") {
      await fulfillJson(route, {
        data: [
          { id: "card-main", model_id: "deepseek-main", model: "deepseek-chat", is_default: true },
          { id: "card-aux", model_id: "deepseek-aux", model: "deepseek-chat", is_default: false },
        ],
        next_cursor: null,
      });
      return;
    }
    if (path === "/v1/skills") {
      await fulfillJson(route, {
        data: [{ id: "skill_custom", display_title: "Custom skill", latest_version: "v3" }],
        next_page: null,
      });
      return;
    }
    if (path === "/v1/oma/me/tenants") {
      await fulfillJson(route, {
        data: [{ id: "tenant_console_e2e", name: "Console E2E", role: "owner" }],
      });
      return;
    }
    await fulfillJson(route, { data: [], next_cursor: null, next_page: null });
  });

  return {
    updates,
    currentAgent: () => structuredClone(agent),
  };
}

function expectHiddenConfigurationPreserved(
  actual: JsonObject,
  expected: JsonObject,
  options: { metadata?: boolean } = {},
): void {
  expect(actual.model).toEqual(expected.model);
  expect(actual._oma).toEqual(expected._oma);
  expect(actual.mcp_servers).toEqual(expected.mcp_servers);
  expect(actual.tools).toEqual(expected.tools);
  expect(actual.skills).toEqual(expected.skills);
  expect(actual.multiagent).toEqual(expected.multiagent);
  if (options.metadata !== false) expect(actual.metadata).toEqual(expected.metadata);
  expect(actual.system).toBe(expected.system);
}

test.describe("Agent config editor lossless browser contract", () => {
  test("a visible Form edit preserves every hidden and advanced field", async ({ page }) => {
    const fixture = await installConsoleFixture(page);
    const before = fixture.currentAgent();

    await page.goto(`/agents/${AGENT_ID}`);
    await expect(page.getByRole("heading", { level: 1, name: before.name })).toBeVisible();
    await page.getByRole("button", { name: "Edit", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Edit Agent" });
    await dialog.locator("#agent-name").fill("Renamed in the browser");
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect.poll(() => fixture.updates.length).toBe(1);
    const after = fixture.currentAgent();
    expect(after.name).toBe("Renamed in the browser");
    expectHiddenConfigurationPreserved(after, before);
  });

  test("Form/YAML/JSON switches are lossless and invalid YAML cannot leave the editor", async ({ page }) => {
    const fixture = await installConsoleFixture(page);
    const before = fixture.currentAgent();

    await page.goto(`/agents/${AGENT_ID}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Agent" });

    await dialog.getByRole("button", { name: "YAML", exact: true }).click();
    const editor = dialog.locator("textarea");
    await expect(editor).toHaveValue(/allowed_domains/);
    await expect(editor).toHaveValue(/provider_options/);

    await dialog.getByRole("button", { name: "JSON", exact: true }).click();
    const json = JSON.parse(await editor.inputValue());
    // Edit mode serializes the official update payload. Unchanged metadata is
    // intentionally omitted because Agent metadata uses nested patch semantics;
    // the preserved baseline must still restore it when returning to Form.
    expect(json.metadata).toBeUndefined();
    expectHiddenConfigurationPreserved(json, before, { metadata: false });

    await dialog.getByRole("button", { name: "Form", exact: true }).click();
    await expect(dialog.locator("#agent-metadata")).toHaveValue(
      JSON.stringify(before.metadata, null, 2),
    );
    await dialog.getByRole("button", { name: "JSON", exact: true }).click();

    await editor.fill("{\n  invalid");
    await dialog.getByRole("button", { name: "Form", exact: true }).click();
    await expect(dialog.getByText(/Invalid JSON/i)).toBeVisible();
    await expect(editor).toBeVisible();
    expect(fixture.updates).toHaveLength(0);

    await editor.fill(JSON.stringify({ description: "Patched from JSON" }, null, 2));
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => fixture.updates.length).toBe(1);

    const after = fixture.currentAgent();
    expect(after.description).toBe("Patched from JSON");
    expectHiddenConfigurationPreserved(after, before);
  });

  test("visible controls across tabs change only their owned fields", async ({ page }) => {
    const fixture = await installConsoleFixture(page);
    const before = fixture.currentAgent();

    await page.goto(`/agents/${AGENT_ID}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Agent" });

    await dialog.locator("#agent-description").fill("Changed across tabs");
    await dialog.locator("#agent-metadata").fill(
      JSON.stringify({ owner: "console-e2e-2", purpose: "regression" }, null, 2),
    );

    await dialog.getByRole("tab", { name: /^Skills/ }).click();
    await dialog.locator('input[placeholder="latest"]').first().fill("2026-10-01");

    await dialog.getByRole("tab", { name: /^MCP Servers/ }).click();
    await dialog.locator("#mcp-name-0").fill("docs-v2");
    await dialog.locator("#mcp-url-0").fill("https://docs-v2.example.test/mcp");

    await dialog.getByRole("tab", { name: /^Multi-Agent/ }).click();
    await dialog.locator("#callable-version-0").fill("9");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => fixture.updates.length).toBe(1);

    const after = fixture.currentAgent();
    expect(after.description).toBe("Changed across tabs");
    expect(after.metadata).toEqual({
      owner: "console-e2e-2",
      purpose: "regression",
    });
    expect(after.skills).toEqual([
      { type: "anthropic", skill_id: "pdf", version: "2026-10-01" },
      before.skills[1],
    ]);
    expect(after.mcp_servers).toEqual([
      { name: "docs-v2", type: "url", url: "https://docs-v2.example.test/mcp" },
    ]);
    expect(after.multiagent).toEqual({
      type: "coordinator",
      agents: [
        { type: "agent", id: "agent_helper", version: 9 },
        { type: "advisor", model: "deepseek-advisor" },
      ],
    });
    expect(after.model).toEqual(before.model);
    expect(after._oma).toEqual(before._oma);
    expect(after.system).toBe(before.system);
    expect(after.tools).toEqual([
      before.tools[0],
      { ...before.tools[1], mcp_server_name: "docs-v2" },
      before.tools[2],
    ]);
  });

  test("creates a standard stdio MCP server without an HTTP adapter shape", async ({ page }) => {
    const fixture = await installConsoleFixture(page);

    await page.goto(`/agents/${AGENT_ID}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Agent" });
    await dialog.getByRole("tab", { name: /^MCP Servers/ }).click();
    await dialog.getByRole("button", { name: "+ Custom server" }).click();
    await dialog.locator("#mcp-name-1").fill("workspace");
    await dialog.locator("#mcp-type-1").click();
    await page.getByRole("option", { name: "stdio" }).click();
    await dialog.locator("#mcp-command-1").fill("/usr/local/bin/workspace-mcp");
    await dialog.locator("#mcp-args-1").fill('["--root","/workspace"]');
    await dialog.locator("#mcp-env-1").fill('{"LOG_LEVEL":"info"}');
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => fixture.updates.length).toBe(1);

    expect(fixture.updates[0].mcp_servers).toEqual([
      { name: "docs", type: "url", url: "https://docs.example.test/mcp" },
      {
        name: "workspace",
        type: "stdio",
        command: "/usr/local/bin/workspace-mcp",
        args: ["--root", "/workspace"],
        env: { LOG_LEVEL: "info" },
      },
    ]);
    expect(fixture.updates[0].mcp_servers[1]).not.toHaveProperty("url");
    expect(fixture.updates[0].mcp_servers[1]).not.toHaveProperty("stdio");
  });
});
