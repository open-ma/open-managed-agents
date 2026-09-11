import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const baseURL = requiredEnv("OMA_E2E_BASE_URL").replace(/\/$/, "");
const apiKey = requiredEnv("OMA_E2E_API_KEY");
const runTurn = process.env.OMA_E2E_RUN_TURN === "1";
const authDisabled = process.env.OMA_E2E_AUTH_DISABLED === "1";
const mockModelBaseURL = process.env.OMA_E2E_MOCK_MODEL_BASE_URL?.replace(/\/$/, "");
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const client = new Anthropic({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout: 60_000,
});

let environment;
let agent;
let session;
let modelCard;
const cleanupErrors = [];

try {
  await step("health endpoint", async () => {
    const response = await fetch(`${baseURL}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });

  await step("Managed Agents beta header is mandatory", async () => {
    const response = await fetch(`${baseURL}/v1/agents`, {
      headers: { "x-api-key": apiKey },
    });
    assert.equal(response.status, 400);
    assertAnthropicError(await response.json(), "invalid_request_error");
  });

  if (!authDisabled) {
    await step("authentication is mandatory", async () => {
      const response = await fetch(`${baseURL}/v1/agents`, {
        headers: { "anthropic-beta": MANAGED_AGENTS_BETA },
      });
      assert.equal(response.status, 401);
      assertAnthropicError(await response.json(), "authentication_error");
    });
  }

  if (mockModelBaseURL) {
    modelCard = await step("install deterministic external LLM fixture", async () => {
      const response = await omaFetch("/v1/oma/model_cards", {
        method: "POST",
        body: JSON.stringify({
          model_id: `e2e-mock-${suffix}`,
          model: "openma-e2e-mock",
          provider: "ant-compatible",
          api_key: "openma-e2e-mock-key",
          base_url: mockModelBaseURL,
        }),
      });
      const responseBody = await response.text();
      assert.equal(response.status, 201, responseBody);
      const created = JSON.parse(responseBody);
      // Assign before assertions so finally can remove a server-created fixture
      // even when a later contract assertion fails.
      modelCard = created;
      assert.match(created.id, /^mdl-/);
      assert.deepEqual(created.probe, { ok: true });
      return created;
    });
  }

  const models = await step("official SDK lists models", async () => {
    const page = await client.beta.models.list({ limit: 10 });
    assert.ok(Array.isArray(page.data));
    assert.ok(page.data.length > 0, "the deployment must expose at least one model");
    assert.equal(page.data[0].type, "model");
    if (modelCard) {
      assert.ok(page.data.some(({ id }) => id === modelCard.model_id));
    }
    return page;
  });
  const model = modelCard?.model_id ?? process.env.OMA_E2E_MODEL ?? models.data[0].id;

  environment = await step("official SDK creates and retrieves an environment", async () => {
    const created = await client.beta.environments.create({
      name: `e2e-environment-${suffix}`,
      description: "Managed Agents deployment E2E",
      scope: "organization",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { type: "packages" },
      },
      metadata: { source: "managed-agents-sdk-e2e" },
    });
    // Take ownership immediately after the remote create succeeds. If any
    // assertion or follow-up read below fails, finally must still delete it.
    environment = created;
    assert.match(created.id, /^env_/);
    assert.equal(created.type, "environment");
    assert.deepEqual(await client.beta.environments.retrieve(created.id), created);
    return created;
  });

  agent = await step("official SDK creates, lists, and retrieves an agent", async () => {
    const created = await client.beta.agents.create({
      name: `e2e-agent-${suffix}`,
      description: "Managed Agents deployment E2E",
      model,
      system: "Reply concisely and do not use tools unless explicitly asked.",
      metadata: { source: "managed-agents-sdk-e2e" },
    });
    agent = created;
    assert.match(created.id, /^agent_/);
    assert.equal(created.type, "agent");
    assert.equal(created.model.id, model);
    assert.deepEqual(await client.beta.agents.retrieve(created.id), created);
    const page = await client.beta.agents.list({ limit: 100 });
    assert.ok(page.data.some(({ id }) => id === created.id));
    assert.ok("next_page" in page);
    return created;
  });

  session = await step("official SDK creates, lists, and retrieves a session", async () => {
    const created = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: `e2e-session-${suffix}`,
      metadata: { source: "managed-agents-sdk-e2e" },
    });
    session = created;
    assert.match(created.id, /^session_/);
    assert.equal(created.type, "session");
    assert.equal(created.agent.id, agent.id);
    assert.deepEqual(await client.beta.sessions.retrieve(created.id), created);
    const page = await client.beta.sessions.list({ limit: 100 });
    assert.ok(page.data.some(({ id }) => id === created.id));
    assert.ok("next_page" in page);
    return created;
  });

  if (runTurn) {
    await step("official SDK sends a turn and receives canonical SSE events", async () => {
      const eventsPromise = collectTurnEvents(session.id).then(
        (events) => ({ events }),
        (error) => ({ error }),
      );
      await delay(500);
      const accepted = await client.beta.sessions.events.send(session.id, {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Reply exactly E2E_OK." }],
          },
        ],
      });
      assert.equal(accepted.data[0]?.type, "user.message");

      const streamed = await eventsPromise;
      if ("error" in streamed) {
        let persistedTypes = "<list failed>";
        try {
          const persisted = await client.beta.sessions.events.list(session.id, {
            limit: 100,
            order: "asc",
          });
          persistedTypes = JSON.stringify(
            persisted.data.map((event) => ({
              type: event.type,
              ...(event.type === "span.model_request_start" && { id: event.id }),
              ...(event.type === "span.model_request_end" && {
                id: event.id,
                model_request_start_id: event.model_request_start_id,
                is_error: event.is_error,
              }),
            })),
          );
        } catch (error) {
          const diagnostic = await fetch(
            `${baseURL}/v1/sessions/${encodeURIComponent(session.id)}/events?limit=100&order=asc`,
            {
              headers: {
                "anthropic-beta": MANAGED_AGENTS_BETA,
                "x-api-key": apiKey,
              },
            },
          ).then(async (response) => `${response.status} ${(await response.text()).slice(0, 2_000)}`)
            .catch(() => error instanceof Error ? error.message : String(error));
          persistedTypes = `<list failed: ${diagnostic}>`;
        }
        throw new Error(
          `${streamed.error instanceof Error ? streamed.error.message : String(streamed.error)}; persisted: ${persistedTypes}`,
          { cause: streamed.error },
        );
      }
      const events = streamed.events;
      const types = events.map(({ type }) => type);
      const diagnostic = JSON.stringify(events);
      assert.ok(types.includes("agent.message"), `received: ${diagnostic}`);
      assert.ok(types.includes("session.status_idle"), `received: ${diagnostic}`);
      const reply = events
        .filter((event) => event.type === "agent.message")
        .flatMap((event) => event.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      assert.equal(reply, "E2E_OK", `received: ${diagnostic}`);
    });
  } else {
    console.log("  ↷ real turn skipped (set OMA_E2E_RUN_TURN=1 to enable)");
  }
} finally {
  if (session) {
    await cleanup("delete session", () => client.beta.sessions.delete(session.id));
  }
  if (agent) {
    await cleanup("archive agent", () => client.beta.agents.archive(agent.id));
  }
  if (environment) {
    await cleanup("delete environment", () => client.beta.environments.delete(environment.id));
  }
  if (modelCard) {
    await cleanup("delete deterministic LLM fixture", async () => {
      const response = await omaFetch(`/v1/oma/model_cards/${encodeURIComponent(modelCard.id)}`, {
        method: "DELETE",
      });
      const responseBody = await response.text();
      assert.equal(response.status, 200, responseBody);
    });
  }
}

if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "E2E cleanup failed");
}

console.log(`\nManaged Agents SDK E2E passed${runTurn ? " with a real turn" : ""}.`);

async function collectTurnEvents(sessionID) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const events = [];
  try {
    const stream = await client.beta.sessions.events.stream(
      sessionID,
      {},
      { signal: controller.signal },
    );
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "session.error") {
          throw new Error(`session.error: ${JSON.stringify(event)}`);
        }
        if (event.type === "session.status_idle") return events;
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; streamed before failure: ${JSON.stringify(events)}`,
        { cause: error },
      );
    }
    throw new Error(
      `SSE ended before session.status_idle; received: ${events
        .map(({ type }) => type)
        .join(", ") || "<none>"}`,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function assertAnthropicError(body, errorType) {
  assert.equal(body?.type, "error");
  assert.equal(body?.error?.type, errorType);
  assert.equal(typeof body?.error?.message, "string");
}

async function step(name, operation) {
  process.stdout.write(`  • ${name} ... `);
  const result = await operation();
  console.log("ok");
  return result;
}

async function cleanup(name, operation) {
  try {
    await step(name, operation);
  } catch (error) {
    cleanupErrors.push(error);
    console.error("failed", error instanceof Error ? error.message : error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function omaFetch(path, init = {}) {
  return fetch(`${baseURL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      ...init.headers,
    },
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
