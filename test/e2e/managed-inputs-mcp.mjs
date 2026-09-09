import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

const baseURL = requiredEnv("OMA_E2E_BASE_URL").replace(/\/$/, "");
const apiKey = requiredEnv("OMA_E2E_API_KEY");
const modelBaseURL = requiredEnv("OMA_E2E_INPUT_MODEL_BASE_URL").replace(/\/$/, "");
const mcpURL = requiredEnv("OMA_E2E_MCP_URL");
const repositoryURL = requiredEnv("OMA_E2E_REPO_URL");
const repositorySha = requiredEnv("OMA_E2E_REPO_SHA");
const repositoryToken = requiredEnv("OMA_E2E_REPO_TOKEN");
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const modelId = `e2e-inputs-${suffix}`;
const client = new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: 60_000 });

let modelCard;
let file;
let memoryStore;
let skill;
let vault;
let credential;
let environment;
let agent;
let session;
const cleanupErrors = [];

try {
  modelCard = await step("install deterministic tool-driving model", async () => {
    const response = await omaFetch("/v1/oma/model_cards", {
      method: "POST",
      body: JSON.stringify({
        model_id: modelId,
        model: "openma-e2e-inputs",
        provider: "ant-compatible",
        api_key: "openma-e2e-inputs-key",
        base_url: modelBaseURL,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    const created = JSON.parse(body);
    modelCard = created;
    assert.deepEqual(created.probe, { ok: true });
    return created;
  });

  file = await step("upload Managed File input", async () => {
    const created = await client.beta.files.upload({
      file: new File(["FILE_INPUT_OK"], "attached.txt", { type: "text/plain" }),
    });
    file = created;
    assert.match(created.id, /^file_/);
    return created;
  });

  memoryStore = await step("create Memory Store input", async () => {
    const created = await client.beta.memoryStores.create({
      name: "certification-memory",
      description: "Managed runtime mount certification",
    });
    memoryStore = created;
    assert.match(created.id, /^memstore_/);
    const memory = await client.beta.memoryStores.memories.create(created.id, {
      path: "/notes/input.txt",
      content: "MEMORY_INPUT_OK",
      view: "full",
    });
    assert.equal(memory.content, "MEMORY_INPUT_OK");
    return created;
  });

  skill = await step("upload custom Skill archive", async () => {
    const created = await client.beta.skills.create({
      display_title: "Input certification skill",
      files: [
        new File(
          [[
              "---",
              "name: certification-skill",
              "description: Proves custom skill materialization",
              "---",
              "",
              "SKILL_INPUT_OK",
              "",
            ].join("\n")],
          "certification-skill/SKILL.md",
          { type: "text/markdown" },
        ),
      ],
    });
    skill = created;
    assert.match(created.id, /^skill_/);
    assert.ok(created.latest_version);
    return created;
  });

  vault = await step("create Vault", async () => {
    const created = await client.beta.vaults.create({
      display_name: `Input certification vault ${suffix}`,
      metadata: { source: "managed-inputs-mcp-e2e" },
    });
    vault = created;
    assert.match(created.id, /^vlt_/);
    return created;
  });

  credential = await step("store MCP bearer in Vault", async () => {
    const created = await client.beta.vaults.credentials.create(vault.id, {
      display_name: "Input certification MCP bearer",
      auth: {
        type: "static_bearer",
        token: "openma-local-release-mcp-token",
        mcp_server_url: mcpURL,
      },
    });
    credential = created;
    assert.match(created.id, /^vcrd_/);
    assert.ok(!JSON.stringify(created).includes("openma-local-release-mcp-token"));
    return created;
  });

  environment = await step("create local execution environment", async () => {
    const created = await client.beta.environments.create({
      name: `e2e-inputs-environment-${suffix}`,
      scope: "organization",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: { type: "packages" },
      },
      metadata: { source: "managed-inputs-mcp-e2e" },
    });
    environment = created;
    assert.match(created.id, /^env_/);
    return created;
  });

  agent = await step("create agent with Skill, bash, and MCP tools", async () => {
    const created = await client.beta.agents.create({
      name: `e2e-inputs-agent-${suffix}`,
      model: modelId,
      system: "Follow the requested certification tool calls exactly.",
      skills: [{ type: "custom", skill_id: skill.id, version: "latest" }],
      mcp_servers: [{ type: "url", name: "certification", url: mcpURL }],
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [{
            name: "bash",
            enabled: true,
            permission_policy: { type: "always_allow" },
          }],
          default_config: { enabled: false },
        },
        {
          type: "mcp_toolset",
          mcp_server_name: "certification",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        },
      ],
      metadata: { source: "managed-inputs-mcp-e2e" },
    });
    agent = created;
    assert.match(created.id, /^agent_/);
    return created;
  });

  session = await step("create session with Memory Store and private pinned repository resources", async () => {
    const created = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      vault_ids: [vault.id],
      resources: [
        {
          type: "github_repository",
          url: repositoryURL,
          authorization_token: repositoryToken,
          checkout: { type: "commit", sha: repositorySha },
          mount_path: "/workspace/repository",
        },
        {
          type: "memory_store",
          memory_store_id: memoryStore.id,
          access: "read_only",
        },
      ],
      title: `e2e-inputs-session-${suffix}`,
      metadata: { source: "managed-inputs-mcp-e2e" },
    });
    session = created;
    assert.match(created.id, /^session_/);
    assert.equal(created.resources.length, 2);
    assert.ok(!JSON.stringify(created).includes(repositoryToken));
    return created;
  });

  await step("add File resource after Session startup", async () => {
    const resource = await client.beta.sessions.resources.add(session.id, {
      type: "file",
      file_id: file.id,
      mount_path: "/workspace/inputs/attached.txt",
    });
    assert.equal(resource.type, "file");
    assert.equal(resource.file_id, file.id);
  });

  await step("run one turn through mounted inputs and Vault-backed MCP", async () => {
    const eventsPromise = collectTurnEvents(session.id);
    await delay(500);
    await client.beta.sessions.events.send(session.id, {
      events: [{
        type: "user.message",
        content: [{
          type: "text",
          text: `Run the complete input and MCP certification. Expected repository SHA: ${repositorySha}.`,
        }],
      }],
    });
    const events = await eventsPromise;
    const bashUse = events.find((event) =>
      event.type === "agent.tool_use" && event.name === "bash"
    );
    const bashResult = events.find((event) =>
      event.type === "agent.tool_result" && event.tool_use_id === bashUse?.id
    );
    const mcpUse = events.find((event) =>
      event.type === "agent.mcp_tool_use"
      && event.name === "mcp__certification__echo"
      && event.mcp_server_name === "certification"
    );
    const mcpResult = events.find((event) =>
      event.type === "agent.mcp_tool_result"
      && event.mcp_tool_use_id === mcpUse?.id
    );
    const finalMessage = events.findLast((event) => event.type === "agent.message");

    assert.ok(bashUse, `missing bash use: ${JSON.stringify(events)}`);
    assert.ok(
      JSON.stringify(bashResult?.content).includes("FILES_REPO_SKILL_MEMORY_OUTPUT_OK"),
      `mounted input assertion failed: ${JSON.stringify(bashResult)}`,
    );
    assert.ok(mcpUse, `missing MCP use: ${JSON.stringify(events)}`);
    assert.ok(
      JSON.stringify(mcpResult?.content).includes("MCP_PROXY_OK"),
      `MCP proxy assertion failed: ${JSON.stringify(mcpResult)}`,
    );
    assert.ok(
      JSON.stringify(finalMessage?.content).includes("ALL_INPUTS_OK"),
      `missing final marker: ${JSON.stringify(finalMessage)}`,
    );
  });

  await step("read durable Session output through the public Node extension", async () => {
    const listedResponse = await omaFetch(`/v1/sessions/${encodeURIComponent(session.id)}/outputs`);
    const listedBody = await listedResponse.text();
    assert.equal(listedResponse.status, 200, listedBody);
    const listed = JSON.parse(listedBody);
    assert.ok(
      listed.data.some((output) => output.filename === "certification.txt"),
      listedBody,
    );
    const outputResponse = await omaFetch(
      `/v1/sessions/${encodeURIComponent(session.id)}/outputs/certification.txt`,
    );
    const outputBody = await outputResponse.text();
    assert.equal(outputResponse.status, 200, outputBody);
    assert.equal(outputBody, "OUTPUT_OK");
  });
} finally {
  if (session) await cleanup("delete session", () => client.beta.sessions.delete(session.id));
  if (agent) await cleanup("archive agent", () => client.beta.agents.archive(agent.id));
  if (environment) {
    await cleanup("delete environment", () => client.beta.environments.delete(environment.id));
  }
  if (credential && vault) {
    await cleanup("delete Vault credential", () =>
      client.beta.vaults.credentials.delete(credential.id, { vault_id: vault.id }));
  }
  if (vault) await cleanup("delete Vault", () => client.beta.vaults.delete(vault.id));
  if (skill) await cleanup("delete Skill", () => client.beta.skills.delete(skill.id));
  if (memoryStore) {
    await cleanup("delete Memory Store", () => client.beta.memoryStores.delete(memoryStore.id));
  }
  if (file) await cleanup("delete File", () => client.beta.files.delete(file.id));
  if (modelCard) {
    await cleanup("delete deterministic tool-driving model", async () => {
      const response = await omaFetch(`/v1/oma/model_cards/${encodeURIComponent(modelCard.id)}`, {
        method: "DELETE",
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
    });
  }
}

if (cleanupErrors.length > 0) {
  throw new AggregateError(cleanupErrors, "Managed inputs/MCP E2E cleanup failed");
}

console.log("\nManaged inputs + MCP E2E passed.");

async function collectTurnEvents(sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  const events = [];
  try {
    const stream = await client.beta.sessions.events.stream(
      sessionId,
      {},
      { signal: controller.signal },
    );
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "session.error") {
          throw new Error(`session.error: ${JSON.stringify(event)}`);
        }
        if (
          event.type === "session.warning"
          && /MCP setup failed/iu.test(String(event.message ?? ""))
        ) {
          throw new Error(`MCP setup failed: ${JSON.stringify(event)}`);
        }
        if (event.type === "session.status_idle") return events;
      }
    } catch (error) {
      const persisted = await omaFetch(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events?limit=100&order=asc`,
        { method: "GET", headers: {} },
      ).then(async (response) => `${response.status} ${(await response.text()).slice(0, 8_000)}`)
        .catch((diagnosticError) =>
          `<diagnostic failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}>`
        );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; streamed before failure: ${JSON.stringify(events)}; persisted: ${persisted}`,
        { cause: error },
      );
    }
    throw new Error(`SSE ended before idle: ${events.map(({ type }) => type).join(", ")}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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

function omaFetch(path, init = {}) {
  return fetch(`${baseURL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01",
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
