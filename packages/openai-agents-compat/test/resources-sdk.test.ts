import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildOpenAIAgentsProtocolApi } from "../../openai-agents-api/src/index";
import { resourcesFixture } from "./helpers/resources";
import type { ResourceRuntimeFiles } from "../src/resource-types";

function sdkFixture(runtime?: ResourceRuntimeFiles) {
  const application = resourcesFixture(runtime);
  const app = buildOpenAIAgentsProtocolApi({ execute: application.handler });
  const client = new OpenAI({ apiKey: "offline-resource-conformance", baseURL: "http://openma.test/v1", maxRetries: 0, fetch: async (input, init) => app.fetch(new Request(input, init)) });
  return { ...application, app, api: client.beta.agents };
}

describe("official SDK → complete HTTP adapter → existing resource application services", () => {
  it("persists saved agent configuration, round-trips all saved tool types and traverses public ID pages", async () => {
    const { api, agents } = sdkFixture();
    const first = await api.create({ model: "gpt-5", name: "First", instructions: "Be concise", metadata: { previous: "remove" }, tools: [
      { type: "function", name: "lookup", description: "Lookup", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, defer_loading: true },
      { type: "tool_search" }, { type: "programmatic_tool_calling", enabled: false },
      { type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://docs.example.test/mcp", headers: { "x-public": "value" } }, allowed_tools: ["read"] },
      { type: "mcp", server_label: "local", transport: { type: "stdio", command: "node", cwd: "/workspace", args: ["mcp.js"], env_vars: ["TOOL_CONFIG"] } },
      { type: "web_search", mode: "cached", allowed_domains: ["example.test"], context_size: "low", location: { country: "US" } },
    ] });
    expect((await api.retrieve(first.id)).tools).toEqual(first.tools);
    const updated = await api.update(first.id, { name: null, instructions: null, metadata: { remaining: "new" }, multi_agent: { enabled: true, max_concurrent_subagents: 3 }, reasoning: { effort: "low", summary: "auto" }, text: { verbosity: "high", format: { type: "json_schema", schema: { type: "object" } } } });
    expect(updated).toMatchObject({ name: null, instructions: null, metadata: { remaining: "new" }, multi_agent: { enabled: true, max_concurrent_subagents: 3 } });
    expect(await agents.retrieveAgent({ agentId: first.id })).toMatchObject({ type: "found", agent: { version: 2, model: { id: "gpt-5", effort: "low" } } });
    const second = await api.create({ model: "gpt-5", name: "Second" });
    const ids: string[] = [];
    for await (const agent of api.list({ limit: 1, order: "asc" })) ids.push(agent.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(await api.delete(first.id)).toEqual({ id: first.id, object: "agent.deleted", deleted: true });
    await expect(api.retrieve(first.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect((await api.list()).data.map(agent => agent.id)).toEqual([second.id]);
  });

  it("creates unnamed and long-named vaults, filters lifecycle statuses, and traverses SDK pagination", async () => {
    const { api, vaults } = sdkFixture();
    const unnamed = await api.vaults.create();
    const named = await api.vaults.create({ name: "猫".repeat(85), metadata: { team: "platform" } });
    expect(await api.vaults.retrieve(unnamed.id)).toMatchObject({ name: null, metadata: {}, object: "vault" });
    expect(await api.vaults.retrieve(named.id)).toMatchObject({ name: "猫".repeat(85), metadata: { team: "platform" } });
    await vaults.archiveVault({ vaultId: named.id });
    const ids: string[] = [];
    for await (const vault of api.vaults.list({ status: ["active", "archived"], limit: 1, order: "asc" })) ids.push(vault.id);
    expect(ids).toEqual([unnamed.id, named.id]);
    expect((await api.vaults.list({ status: "archived" })).data.map(v => v.id)).toEqual([named.id]);
    expect(await api.vaults.delete(unnamed.id)).toEqual({ id: unnamed.id, object: "vault.deleted", deleted: true });
    await expect(api.vaults.retrieve(unnamed.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("creates, retrieves, rotates, lists and deletes credential secrets through the existing vault application", async () => {
    const { api, credentialStore } = sdkFixture();
    const vault = await api.vaults.create();
    const bearer = await api.vaults.credentials.create(vault.id, { name: "Bearer", auth: { type: "static_bearer", token: "initial-private-token", mcp_server_url: "https://mcp.example.test" } });
    const oauth = await api.vaults.credentials.create(vault.id, { name: "OAuth", auth: { type: "mcp_oauth", access_token: "oauth-private-token", mcp_server_url: "https://mcp.example.test", refresh: { client_id: "public-client", refresh_token: "refresh-private-token", token_endpoint: "https://mcp.example.test/token", token_endpoint_auth: { type: "client_secret_basic", client_secret: "private-client-secret" } } } });
    expect(await api.vaults.credentials.retrieve(bearer.id, { vault_id: vault.id })).toEqual(bearer);
    const updated = await api.vaults.credentials.update(bearer.id, { vault_id: vault.id, auth: { type: "static_bearer", token: "rotated-private-token" } });
    expect(updated.auth).toEqual({ type: "static_bearer", mcp_server_url: "https://mcp.example.test" });
    expect((await credentialStore.find({ workspaceId: "workspace_a", vaultId: vault.id, credentialId: bearer.id }))?.credential.auth).toMatchObject({ token: "rotated-private-token" });
    const ids: string[] = [];
    for await (const credential of api.vaults.credentials.list(vault.id, { limit: 1, order: "asc" })) ids.push(credential.id);
    expect(ids).toEqual([bearer.id, oauth.id]);
    expect(JSON.stringify([bearer, oauth, updated])).not.toMatch(/private-token|private-client-secret/);
    expect(await api.vaults.credentials.delete(bearer.id, { vault_id: vault.id })).toEqual({ id: bearer.id, object: "vault.credential.deleted", deleted: true });
    await expect(api.vaults.credentials.retrieve(bearer.id, { vault_id: vault.id })).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    await api.vaults.delete(vault.id);
    expect(await credentialStore.find({ workspaceId: "workspace_a", vaultId: vault.id, credentialId: oauth.id })).toBeNull();
  });

  it("round-trips template metadata, encrypts confidential configuration and executes versioned template replacement", async () => {
    const { api, environments, handler } = sdkFixture();
    const template = await api.environments.templates.create({ name: "Build", env: { SECRET: "private-value" }, setup_commands: [{ command: "printf private-command", cwd: "/workspace" }], capability_directories: ["/workspace/capabilities"], packages: { npm: ["typescript"], python: ["pandas"], system: ["curl"] }, network: { access: "restricted", allowed_domains: ["packages.example.test"] }, files: [{ type: "inline", path: "/workspace/a", data: "aGVsbG8=" }], plugins: [{ type: "inline", name: "tools", description: "Tools", source: { type: "base64", data: "UEs=", media_type: "application/zip" } }], skills: [{ type: "skill_reference", skill_id: "skill_1", version: "latest" }] });
    expect(await api.environments.templates.retrieve(template.id)).toEqual(template);
    expect(template.files).toEqual([{ type: "inline", path: "/workspace/a", size_bytes: 5 }]);
    expect(JSON.stringify(template)).not.toMatch(/private-value|private-command|aGVsbG8=|UEs=/);
    expect(await handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: template.id })).toMatchObject({ env: { SECRET: "private-value" }, setup_commands: [{ command: "printf private-command" }] });
    const second = await api.environments.templates.create();
    const ids: string[] = [];
    for await (const item of api.environments.templates.list({ limit: 1, order: "asc" })) ids.push(item.id);
    expect(ids).toEqual([template.id, second.id]);
    const updated = await api.environments.templates.update(template.id, { name: null, env: null, setup_commands: null, files: null, network: { access: "disabled" } });
    expect(updated).toMatchObject({ name: null, files: [], network: { access: "disabled", allowed_domains: [] } });
    expect(await environments.retrieveEnvironment({ environmentId: template.id })).toMatchObject({ type: "found", environment: { config: { networking: { type: "limited", allowedHosts: [] } } } });
    expect(await api.environments.templates.delete(template.id)).toEqual({ id: template.id, object: "agent.environment.template.deleted", deleted: true });
    await expect(api.environments.templates.retrieve(template.id)).rejects.toBeInstanceOf(OpenAI.NotFoundError);
  });

  it("writes actual binary environment files and follows opaque SDK file pagination", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-sdk-files-"));
    const native = (path: string) => join(root, path.replace(/^\/workspace\/?/, ""));
    let environmentId = "";
    const runtime: ResourceRuntimeFiles = {
      async getEnvironment(id) { return id === environmentId ? { id, object: "agent.environment", type: "self_hosted", status: "connected", files: [], plugins: [], skills: [] } : null; },
      async writeFile(_id, path, bytes) { await mkdir(dirname(native(path)), { recursive: true }); await writeFile(native(path), bytes); },
      async listFiles(_id, path = "/workspace") { const entries = await readdir(native(path), { withFileTypes: true }); return Promise.all(entries.filter(entry => entry.isFile()).map(async entry => ({ path: `${path}/${entry.name}`, size_bytes: (await stat(native(`${path}/${entry.name}`))).size }))); },
    };
    try {
      const { api, environments, files } = sdkFixture(runtime);
      const provisioned = await environments.createEnvironment({ name: "Files test", config: { type: "cloud" } });
      if (provisioned.type !== "created") throw new Error("Could not prepare test environment");
      environmentId = provisioned.environment.id;
      expect(await api.environments.retrieve(environmentId)).toMatchObject({ id: environmentId, status: "connected", type: "self_hosted" });
      expect(await api.environments.files.create(environmentId, { type: "inline", path: "/workspace/a.bin", data: "AP/+" })).toEqual({ object: "agent.environment.file", environment_id: environmentId, path: "/workspace/a.bin", size_bytes: 3 });
      expect([...await readFile(native("/workspace/a.bin"))]).toEqual([0, 255, 254]);
      await api.environments.files.create(environmentId, { type: "inline", path: "/workspace/b.txt", data: "b2s=" });
      const uploaded = await files.uploadFile({ filename: "source.bin", mimeType: "application/octet-stream", content: new Uint8Array([254, 0, 129]) });
      if (uploaded.type !== "uploaded") throw new Error("Could not prepare source file");
      await api.environments.files.create(environmentId, { type: "file_id", path: "/workspace/c.bin", file_id: uploaded.file.id });
      expect([...await readFile(native("/workspace/c.bin"))]).toEqual([254, 0, 129]);
      const paths: string[] = [];
      for await (const file of api.environments.files.list(environmentId, { limit: 1, order: "asc", path: "/workspace" })) paths.push(file.path);
      expect(paths).toEqual(["/workspace/a.bin", "/workspace/b.txt", "/workspace/c.bin"]);
      await expect(api.environments.files.create(environmentId, { type: "inline", path: "/workspace/../escape", data: "b2s=" })).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
