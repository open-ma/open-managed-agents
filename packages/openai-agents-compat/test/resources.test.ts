import { describe, expect, it } from "vitest";
import { AgentsApplicationService, CredentialsApplicationService, EnvironmentsApplicationService, VaultsApplicationService } from "../../managed-agents-application/src/index";
import { MemoryAgentStore } from "../../agent-store-memory/src/index";
import { MemoryVaultStore } from "../../vault-store-memory/src/index";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { MemoryEnvironmentStore } from "../../environment-store-memory/src/index";
import { createResourcesHandler } from "../src/resources";
import type { OpenAIAgentsOperationRequest } from "../../openai-agents-api/src/index";
import { validateOpenAIAgentsSchema } from "../../openai-agents-api/src/index";
import { auditAgentRuntimeMapping } from "../src/resources";
import type { ResourceRuntimeFiles } from "../src/resource-types";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resourcesFixture as fixture } from "./helpers/resources";

describe("OpenAI resource compatibility using real application services", () => {
  it("reflects native agent edits instead of replaying a duplicate saved resource", async () => {
    const f = fixture();
    const created = await f.run("agents.create", { model: "gpt-5", instructions: "before", metadata: { owner: "first", __openai_agents_v1: "user-owned-value" }, name: null, tools: [{ type: "function", name: "lookup", description: "Old description", parameters: { type: "object" }, defer_loading: true }] });
    await f.agents.updateAgent({ agentId: created.id, name: "Edited natively", system: "after", model: "gpt-6", metadata: { owner: "second" }, tools: [{ type: "custom", name: "lookup", description: "Current description", inputSchema: { type: "object", required: ["id"] } }] });
    const retrieved = await f.run("agents.retrieve", {}, { agent_id: created.id });
    expect(retrieved).toMatchObject({ name: "Edited natively", model: "gpt-6", instructions: "after", metadata: { owner: "second", __openai_agents_v1: "user-owned-value" }, tools: [{ description: "Current description", defer_loading: true, parameters: { required: ["id"] } }] });
    expect(Object.keys(retrieved.metadata)).toHaveLength(2);
  });

  it("reflects native template network/package changes without a separate template copy", async () => {
    const f = fixture();
    const created = await f.run("environments.templates.create", { name: null, network: { access: "disabled" }, packages: { python: ["numpy"] }, env: { API_TOKEN: "secret" } });
    await f.environments.updateEnvironment({ environmentId: created.id, name: "Edited environment", config: { type: "cloud", networking: { type: "limited", allowedHosts: ["api.example.com"] }, packages: { npm: ["lodash"] } } });
    expect(await f.run("environments.templates.retrieve", {}, { environment_template_id: created.id })).toMatchObject({ name: "Edited environment", network: { access: "restricted", allowed_domains: ["api.example.com"] }, packages: { npm: ["lodash"], python: [] } });
    expect(await f.handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: created.id })).toMatchObject({ env: { API_TOKEN: "secret" }, network: { access: "restricted", allowed_domains: ["api.example.com"] }, packages: { npm: ["lodash"] } });
  });

  it("projects existing native cloud environment definitions as reusable templates", async () => {
    const f = fixture();
    const native = await f.environments.createEnvironment({ name: "Existing environment", config: { type: "cloud", networking: { type: "unrestricted" }, packages: { pip: ["numpy"] } } });
    if (native.type !== "created") throw new Error("Test environment creation failed");
    expect(await f.run("environments.templates.retrieve", {}, { environment_template_id: native.environment.id })).toMatchObject({ id: native.environment.id, name: "Existing environment", packages: { python: ["numpy"] } });
    expect(await f.run("environments.templates.list")).toMatchObject({ data: [{ id: native.environment.id }] });
  });

  it("uses native vault renames and preserves metadata keys that collide with adapter storage", async () => {
    const f = fixture();
    const vault = await f.run("vaults.create", { metadata: { __openai_agents_v1: "public", owner: "first" } });
    await f.vaults.updateVault({ vaultId: vault.id, displayName: "Renamed natively", metadata: { owner: "second" } });
    expect(await f.run("vaults.retrieve", {}, { vault_id: vault.id })).toMatchObject({ name: "Renamed natively", metadata: { __openai_agents_v1: "public", owner: "second" } });
  });

  it("reports runtime capabilities required by configuration that native agent fields cannot express", () => {
    expect(auditAgentRuntimeMapping({ model: "gpt-5", reasoning: { effort: "low" }, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] })).toEqual([]);
    expect(auditAgentRuntimeMapping({ model: "gpt-5", multi_agent: { enabled: true }, reasoning: { effort: "minimal", summary: "auto" }, service_tier: "priority", text: { format: { type: "json_schema" }, verbosity: "high" }, tools: [{ type: "function", name: "lookup", defer_loading: true }, { type: "mcp", server_label: "local", transport: { type: "stdio", command: "node", cwd: "/workspace" }, required: true }, { type: "programmatic_tool_calling" }] })).toEqual(expect.arrayContaining([
      { path: "multi_agent", capability: "dynamic_subagents" }, { path: "reasoning.effort", capability: "reasoning_effort" }, { path: "service_tier", capability: "service_tier" },
      { path: "tools.0.defer_loading", capability: "deferred_tools" }, { path: "tools.1.transport", capability: "mcp_stdio" }, { path: "tools.1.required", capability: "mcp_required_initialization" }, { path: "tools.2", capability: "programmatic_tool_calling" },
    ]));
  });

  it("keeps nullable names and replacement metadata while updating the existing versioned agent", async () => {
    const f = fixture();
    const agent = await f.run("agents.create", { model: "gpt-5", instructions: "Answer carefully", metadata: { remove: "old" }, tools: [{ type: "function", name: "lookup", description: "Look up a record", parameters: { type: "object", properties: {} } }] });
    expect(agent).toMatchObject({ object: "agent", name: null, instructions: "Answer carefully", model: "gpt-5", tools: [{ type: "function", defer_loading: false, name: "lookup" }] });
    const core = await f.agents.retrieveAgent({ agentId: agent.id });
    expect(core).toMatchObject({ type: "found", agent: { system: "Answer carefully", tools: [{ type: "custom", name: "lookup" }] } });
    const updated = await f.run("agents.update", { name: "Research", instructions: null, metadata: { only: "new" }, text: { verbosity: "high" } }, { agent_id: agent.id });
    expect(updated).toMatchObject({ name: "Research", instructions: null, metadata: { only: "new" }, text: { verbosity: "high", format: { type: "text" } } });
    expect(updated.metadata).not.toHaveProperty("remove");
    expect(await f.agents.retrieveAgent({ agentId: agent.id })).toMatchObject({ agent: { version: 2, metadata: { only: "new" } } });
    expect(await f.run("agents.delete", {}, { agent_id: agent.id })).toEqual({ id: agent.id, object: "agent.deleted", deleted: true });
    await expect(f.run("agents.retrieve", {}, { agent_id: agent.id })).rejects.toMatchObject({ status: 404 });
  });

  it("paginates by public IDs and hides deleted agents", async () => {
    const f = fixture();
    const first = await f.run("agents.create", { model: "gpt-5", name: "First" });
    const second = await f.run("agents.create", { model: "gpt-5", name: "Second" });
    const third = await f.run("agents.create", { model: "gpt-5", name: "Third" });
    const page = await f.run("agents.list", {}, {}, { order: "asc", limit: 1 });
    expect(page).toMatchObject({ data: [{ id: first.id }], has_more: true });
    expect(await f.run("agents.list", {}, {}, { order: "asc", after: first.id })).toMatchObject({ data: [{ id: second.id }, { id: third.id }], has_more: false });
    await expect(f.run("agents.list", {}, {}, { after: "someone_elses_agent" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps native support records for inline session agents out of reusable agent APIs", async () => {
    const f = fixture();
    const support = await f.agents.createAgent({ name: "Inline session agent", model: "gpt-5", metadata: { __openai_agents_v1: JSON.stringify({ version: 1, kind: "agent", fields: { session_inline: true } }) } });
    if (support.type !== "created") throw new Error("Support agent creation failed");
    const reusable = await f.run("agents.create", { name: "Reusable", model: "gpt-5" });
    expect(await f.run("agents.list")).toMatchObject({ data: [{ id: reusable.id }] });
    for (const operation of ["agents.retrieve", "agents.update", "agents.delete"] as const) await expect(f.run(operation, {}, { agent_id: support.agent.id })).rejects.toMatchObject({ status: 404 });
    expect(await f.agents.retrieveAgent({ agentId: support.agent.id })).toMatchObject({ type: "found", agent: { archivedAt: null } });
  });

  it("accepts unnamed vaults and preserves display names too long for the native name representation", async () => {
    const f = fixture();
    const unnamed = await f.run("vaults.create");
    expect(unnamed).toMatchObject({ object: "vault", name: null });
    const long = await f.run("vaults.create", { name: "x".repeat(256) });
    expect(await f.run("vaults.retrieve", {}, { vault_id: long.id })).toMatchObject({ name: "x".repeat(256) });
    await f.vaults.archiveVault({ vaultId: long.id });
    expect(await f.run("vaults.list", {}, {}, { status: "active" })).toMatchObject({ data: [{ id: unnamed.id }] });
    expect(await f.run("vaults.list", {}, {}, { status: ["archived"] })).toMatchObject({ data: [{ id: long.id }] });
  });

  it("rotates OAuth secrets through existing credentials and never writes raw tokens to the compatibility sidecar", async () => {
    const f = fixture();
    const vault = await f.run("vaults.create", { name: "Secrets" });
    const credential = await f.run("vaults.credentials.create", { name: "OAuth", auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.example.com", access_token: "secret-access", expires_at: "2030-01-01T00:00:00Z", refresh: { client_id: "client", refresh_token: "secret-refresh", token_endpoint: "https://mcp.example.com/token", token_endpoint_auth: { type: "client_secret_post", client_secret: "secret-client" } } } }, { vault_id: vault.id });
    expect(credential).toMatchObject({ object: "vault.credential", name: "OAuth", auth: { type: "mcp_oauth", expires_at: "2030-01-01T00:00:00Z", refresh: { client_id: "client", scope: null, resource: null, token_endpoint_auth: { type: "client_secret_post" } } } });
    const updated = await f.run("vaults.credentials.update", { auth: { type: "mcp_oauth", access_token: "replacement-access" } }, { vault_id: vault.id, credential_id: credential.id });
    expect(updated.auth.expires_at).toBeNull();
    const record = await f.credentialStore.find({ workspaceId: "workspace_a", vaultId: vault.id, credentialId: credential.id });
    expect(record?.credential.auth).toMatchObject({ accessToken: "replacement-access", refresh: { refreshToken: "secret-refresh" } });
    expect(JSON.stringify([credential, updated])).not.toMatch(/secret-access|secret-refresh|secret-client|replacement-access/);
    await expect(f.run("vaults.credentials.retrieve", {}, { vault_id: "other-vault", credential_id: credential.id })).rejects.toMatchObject({ status: 404 });
    expect(await f.run("vaults.credentials.delete", {}, { vault_id: vault.id, credential_id: credential.id })).toMatchObject({ object: "vault.credential.deleted", deleted: true });
  });

  it("maps templates to core environments, encrypts confidential inputs, replaces updates, and erases them on deletion", async () => {
    const f = fixture();
    const template = await f.run("environments.templates.create", { env: { TOKEN: "secret-template" }, setup_commands: [{ command: "echo secret-command" }], files: [{ type: "inline", path: "/workspace/hello.txt", data: "aGVsbG8=" }], packages: { python: ["numpy"] }, network: { access: "disabled" } });
    expect(template).toMatchObject({ object: "agent.environment.template", name: null, network: { access: "disabled", allowed_domains: [] }, packages: { python: ["numpy"], npm: [], system: [] }, files: [{ type: "inline", path: "/workspace/hello.txt", size_bytes: 5 }] });
    expect(await f.environments.retrieveEnvironment({ environmentId: template.id })).toMatchObject({ environment: { config: { type: "cloud", networking: { type: "limited", allowedHosts: [] }, packages: { pip: ["numpy"] } } } });
    const stored = await f.environments.retrieveEnvironment({ environmentId: template.id });
    expect(JSON.stringify([template, stored])).not.toMatch(/secret-template|secret-command|aGVsbG8=/);
    const updated = await f.run("environments.templates.update", { env: null, setup_commands: null, files: null, name: "Template" }, { environment_template_id: template.id });
    expect(updated).toMatchObject({ name: "Template", files: [] });
    expect(await f.run("environments.templates.delete", {}, { environment_template_id: template.id })).toMatchObject({ object: "agent.environment.template.deleted", deleted: true });
    expect(await f.environments.retrieveEnvironment({ environmentId: template.id })).toEqual({ type: "not_found" });
  });

  it("resolves all saved tool variants to official SDK response shapes and keeps native MCP/search restrictions", async () => {
    const f = fixture();
    const agent = await f.run("agents.create", { model: "gpt-5", multi_agent: { enabled: true }, tools: [
      { type: "function", name: "lookup", description: "Look up", parameters: { type: "object" }, defer_loading: true },
      { type: "tool_search" }, { type: "programmatic_tool_calling" },
      { type: "mcp", server_label: "docs", transport: { type: "http", server_url: "https://docs.example.com/mcp" }, allowed_tools: ["search"] },
      { type: "mcp", server_label: "local", transport: { type: "stdio", command: "node", cwd: "/workspace" } },
      { type: "web_search", allowed_domains: ["example.com"], location: { country: "US" } },
    ] });
    expect(validateOpenAIAgentsSchema(agent, "agents.Agent")).toEqual({ success: true });
    expect(agent.multi_agent).toEqual({ enabled: true, max_concurrent_subagents: 6 });
    const core = await f.agents.retrieveAgent({ agentId: agent.id });
    expect(core).toMatchObject({ agent: { mcpServers: [{ name: "docs", url: "https://docs.example.com/mcp" }], tools: expect.arrayContaining([
      expect.objectContaining({ type: "mcp_toolset", defaultConfig: expect.objectContaining({ enabled: false }), configs: [expect.objectContaining({ name: "search", enabled: true })] }),
      expect.objectContaining({ type: "agent_toolset_20260401", configs: expect.arrayContaining([expect.objectContaining({ name: "web_search", allowedDomains: ["example.com"] })]) }),
    ]) } });
  });

  it("inherits template confidential inputs and forbids session overrides that broaden its network", async () => {
    const f = fixture();
    const template = await f.run("environments.templates.create", { name: "Restricted", env: { TOKEN: "secret" }, files: [{ type: "file_id", file_id: "file_1", path: "/workspace/data.bin" }], skills: [{ type: "skill_reference", skill_id: "skill_1" }], plugins: [{ type: "inline", name: "plugin", description: "Tools", source: { type: "base64", media_type: "application/zip", data: "UEs=" } }], network: { access: "restricted", allowed_domains: ["api.example.com"] } });
    expect(validateOpenAIAgentsSchema(template, "environments.templates.EnvironmentTemplate")).toEqual({ success: true });
    expect(await f.handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: template.id })).toMatchObject({ env: { TOKEN: "secret" }, network: { access: "restricted", allowed_domains: ["api.example.com"] } });
    await expect(f.handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: template.id, network: { access: "enabled" } })).rejects.toMatchObject({ status: 400 });
    await expect(f.handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: template.id, network: { access: "restricted", allowed_domains: ["evil.example"] } })).rejects.toMatchObject({ status: 400 });
    expect(await f.handler.resolveEnvironmentConfiguration({ type: "openai_hosted", environment_template_id: template.id, network: { access: "disabled" }, env: null })).toMatchObject({ network: { access: "disabled" }, env: null });
  });

  it("deletes the actual credential secret records when a vault is deleted", async () => {
    const f = fixture();
    const vault = await f.run("vaults.create");
    const credential = await f.run("vaults.credentials.create", { name: "Bearer", auth: { type: "static_bearer", token: "delete-me", mcp_server_url: "https://api.example.com" } }, { vault_id: vault.id });
    expect(validateOpenAIAgentsSchema(credential, "vaults.credentials.Credential")).toEqual({ success: true });
    await f.run("vaults.delete", {}, { vault_id: vault.id });
    expect(await f.credentialStore.find({ workspaceId: "workspace_a", vaultId: vault.id, credentialId: credential.id })).toBeNull();
    await expect(f.run("vaults.credentials.list", {}, { vault_id: vault.id })).rejects.toMatchObject({ status: 404 });
  });

  it("materializes binary bytes in the runtime and returns SDK TokenPage next/page cursors scoped to a directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openai-resource-files-"));
    const nativePath = (path: string) => join(directory, path.slice("/workspace/".length));
    const runtime: ResourceRuntimeFiles = {
      getEnvironment: async id => id === "env_live" ? { id, object: "agent.environment", type: "openai_hosted", status: "connected", files: [], skills: [], plugins: [] } : null,
      writeFile: async (_id, path, content) => { const dest = nativePath(path); await mkdir(join(dest, ".."), { recursive: true }); await writeFile(dest, content); },
      listFiles: async (_id, path) => { const entries = await readdir(nativePath(`${path}/`), { withFileTypes: true }); return Promise.all(entries.filter(e => e.isFile()).map(async entry => ({ path: `${path}/${entry.name}`, size_bytes: (await stat(nativePath(`${path}/${entry.name}`))).size }))); },
    };
    try {
      const f = fixture(runtime);
      const binary = await f.run("environments.files.create", { type: "inline", path: "/workspace/一.bin", data: "AP/+" }, { environment_id: "env_live" });
      expect(validateOpenAIAgentsSchema(binary, "environments.files.EnvironmentFile")).toEqual({ success: true });
      expect([...await readFile(nativePath("/workspace/一.bin"))]).toEqual([0, 255, 254]);
      await f.run("environments.files.create", { type: "inline", path: "/workspace/z.txt", data: "aGk=" }, { environment_id: "env_live" });
      const first = await f.run("environments.files.list", {}, { environment_id: "env_live" }, { limit: 1, order: "desc" });
      expect(first).toMatchObject({ data: [{ path: "/workspace/一.bin" }], has_more: true, next: expect.any(String) });
      expect(await f.run("environments.files.list", {}, { environment_id: "env_live" }, { limit: 1, order: "desc", page: first.next })).toMatchObject({ data: [{ path: "/workspace/z.txt" }], has_more: false, next: null });
      await expect(f.run("environments.files.list", {}, { environment_id: "env_live" }, { order: "asc", page: first.next })).rejects.toMatchObject({ status: 400 });
      await expect(f.run("environments.files.create", { type: "inline", path: "/workspace/../escape", data: "aA==" }, { environment_id: "env_live" })).rejects.toMatchObject({ status: 400 });
      await expect(f.run("environments.files.create", { type: "inline", path: "/workspace/invalid.txt", data: "%%%" }, { environment_id: "env_live" })).rejects.toMatchObject({ status: 400 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
