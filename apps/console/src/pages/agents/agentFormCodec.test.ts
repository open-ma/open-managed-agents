import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../../types/agent";
import {
  INITIAL_FORM,
  agentToForm,
  agentToPreservedConfig,
  buildModelValue,
  configToForm,
  mergeFormIntoConfig,
  mergeMcpServers,
  mergeToolsField,
  materializeAgentUpdate,
  parseAgentConfigText,
  prepareCodePayload,
} from "./agentFormCodec";

function sampleAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_1",
    type: "agent",
    name: "Coder",
    model: {
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    },
    system: "Be helpful",
    version: 3,
    description: "desc",
    created_at: "2026-01-01T00:00:00.000Z",
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      },
      {
        type: "custom",
        name: "deploy",
        description: "Deploy app",
        input_schema: { type: "object", properties: {} },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_ask" } },
      },
      { type: "future_toolset_2099", keep: true },
    ],
    mcp_servers: [
      {
        name: "github",
        type: "url",
        url: "https://mcp.example.test/github",
      },
    ],
    metadata: { team: "platform", owner: "alice" },
    ...overrides,
  } as AgentRecord;
}

describe("agentFormCodec lossless update", () => {
  it("rejects malformed or non-object YAML/JSON before an editor mode switch", () => {
    expect(() => parseAgentConfigText("name: [", "yaml")).toThrow(/invalid yaml/i);
    expect(() => parseAgentConfigText("- name: coder", "yaml")).toThrow(/object/i);
    expect(() => parseAgentConfigText('"coder"', "json")).toThrow(/object/i);
    expect(parseAgentConfigText('{"name":"Coder"}', "json")).toEqual({ name: "Coder" });
  });

  it("preserves model.speed on a name-only edit", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    expect(form.model).toBe("claude-sonnet-4-6");
    expect(form.modelSpeed).toBe("fast");
    expect(buildModelValue(form)).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });

    form.name = "Renamed";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    expect(payload.name).toBe("Renamed");
    expect(payload.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    });
  });

  it("merges tools without dropping custom / unknown / mcp policies", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.name = "Still Coder";

    const tools = mergeToolsField(agent.tools, form);
    expect(tools.some((t) => (t as { type?: string }).type === "custom")).toBe(true);
    expect(tools.some((t) => (t as { type?: string }).type === "future_toolset_2099")).toBe(
      true,
    );
    const mcp = tools.find(
      (t) =>
        (t as { type?: string }).type === "mcp_toolset" &&
        (t as { mcp_server_name?: string }).mcp_server_name === "github",
    ) as { default_config?: { permission_policy?: { type?: string } } };
    expect(mcp?.default_config?.permission_policy?.type).toBe("always_ask");

    const builtin = tools.find(
      (t) => (t as { type?: string }).type === "agent_toolset_20260401",
    ) as { configs?: Array<{ name: string }> };
    expect(builtin?.configs?.some((c) => c.name === "bash")).toBe(true);
  });

  it("keeps the original tool array order during an unrelated Form edit", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);

    expect(mergeToolsField(agent.tools, form)).toEqual(agent.tools);
  });

  it("preserves advanced built-in tool configuration on a name-only edit", () => {
    const agent = sampleAgent({
      mcp_servers: [],
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
      ],
    });
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.tools).toEqual(agent.tools);
  });

  it("resets only form-owned tool policy while retaining advanced settings", () => {
    const agent = sampleAgent({
      mcp_servers: [],
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
              max_content_tokens: 4096,
            },
          ],
        },
      ],
    });
    const form = agentToForm(agent);
    form.toolOverrides.web_fetch = "default";

    const tools = mergeToolsField(agent.tools, form);

    expect(tools).toEqual([
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
            allowed_domains: ["docs.example.test"],
            max_content_tokens: 4096,
          },
        ],
      },
    ]);
  });

  it("preserves a Managed URL MCP server", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    const merged = mergeMcpServers(agent.mcp_servers as unknown[], form.mcpServers);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      name: "github",
      type: "url",
      url: "https://mcp.example.test/github",
    });
  });

  it("preserves MCP config and tool policy when an existing server is renamed", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.mcpServers[0].name = "renamed-github";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.mcp_servers).toEqual([
      {
        name: "renamed-github",
        type: "url",
        url: "https://mcp.example.test/github",
      },
    ]);
    expect(payload.tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "renamed-github",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("round-trips official top-level fields through form update merge", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.description = "tweaked";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    // Omission is the official update meaning for "preserve unchanged".
    expect(payload.metadata).toBeUndefined();
    expect(payload.description).toBe("tweaked");
    expect(payload.id).toBeUndefined();
    expect(payload.version).toBeUndefined();
  });

  it("edits metadata with update-patch deletion semantics", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    expect(JSON.parse(form.metadataJson)).toEqual({
      team: "platform",
      owner: "alice",
    });
    form.metadataJson = JSON.stringify({ owner: "bob", purpose: "review" });

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.metadata).toEqual({
      team: null,
      owner: "bob",
      purpose: "review",
    });
  });

  it("emits create metadata as a full object and rejects invalid form JSON", () => {
    const form = {
      ...INITIAL_FORM,
      name: "Coder",
      model: "deepseek-chat",
      metadataJson: '{"team":"platform"}',
    };
    expect(
      mergeFormIntoConfig(form, null, { forUpdate: false }).metadata,
    ).toEqual({ team: "platform" });

    form.metadataJson = "{";
    expect(() => mergeFormIntoConfig(form, null, { forUpdate: false })).toThrow(
      /metadata.*json/i,
    );
  });

  it("keeps unsupported fields when Form state is re-merged after a mode switch baseline", () => {
    const agent = sampleAgent();
    const base = agentToPreservedConfig(agent);
    const form = agentToForm(agent);
    form.name = "After YAML peek";
    const afterForm = mergeFormIntoConfig(form, base, { forUpdate: true });
    const payload = mergeFormIntoConfig(
      { ...agentToForm(agent), name: "Final" },
      afterForm,
      { forUpdate: true },
    );
    expect(payload.name).toBe("Final");
    expect(payload.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    });
    expect(
      (payload.tools as unknown[]).some((t) => (t as { type?: string }).type === "custom"),
    ).toBe(true);
    expect((payload.mcp_servers as Array<{ url?: unknown }>)[0]?.url).toBe(
      "https://mcp.example.test/github",
    );
    expect(payload.metadata).toEqual({ team: "platform", owner: "alice" });
  });

  it("materializes an update patch before switching back to Form mode", () => {
    const current = agentToPreservedConfig(
      sampleAgent({
        _oma: {
          aux_model: { id: "deepseek-chat" },
          harness: "pi",
        },
      }),
    );

    const materialized = materializeAgentUpdate(current, {
      metadata: { owner: "bob" },
      tools: null,
      _oma: { aux_model: null },
    });

    expect(materialized.metadata).toEqual({ team: "platform", owner: "bob" });
    expect(materialized.tools).toEqual([]);
    expect(materialized._oma).toEqual({ harness: "pi" });
  });

  it("does not carry provider-specific options onto a different model", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.model = "deepseek-chat";
    form.modelSpeed = "";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.model).toBe("deepseek-chat");
  });

  it("does not carry provider-specific options onto a different auxiliary model", () => {
    const agent = sampleAgent({
      _oma: {
        aux_model: {
          id: "claude-haiku-4-5",
          speed: "fast",
          provider_options: { anthropic: { beta: ["context-1m"] } },
        },
      },
    });
    const form = agentToForm(agent);
    form.auxiliaryModel = "deepseek-chat";
    form.auxiliaryModelSpeed = "";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload._oma).toEqual({ aux_model: { id: "deepseek-chat" } });
  });

  it("preserves advisor roster members that the Form does not edit", () => {
    const agent = sampleAgent({
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_reviewer", version: 3 },
          { type: "advisor", model: "claude-haiku-4-5" },
        ],
      },
    });
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.multiagent).toEqual(agent.multiagent);
  });

  it("does not silently pin an unversioned callable agent to version 1", () => {
    const config = agentToPreservedConfig(sampleAgent());
    config.multiagent = {
      type: "coordinator",
      agents: [{ type: "agent", id: "agent_reviewer" }],
    };
    const form = configToForm(config);

    expect(form.callableAgents).toEqual([
      { type: "agent", id: "agent_reviewer" },
    ]);
    expect(
      mergeFormIntoConfig(form, config, { forUpdate: true })
        .multiagent,
    ).toEqual({
      type: "coordinator",
      agents: [{ type: "agent", id: "agent_reviewer" }],
    });
  });
});

describe("agent endpoint boundary", () => {
  it("preserves update omissions and explicit clears in code mode", () => {
    expect(
      prepareCodePayload({ model: "deepseek-chat" }, { forUpdate: true }),
    ).toEqual({ model: "deepseek-chat" });
    expect(
      prepareCodePayload({ tools: null }, { forUpdate: true }),
    ).toEqual({ tools: null });
  });

  it("requires a create name and only defaults omitted create tools", () => {
    expect(() =>
      prepareCodePayload({ model: "deepseek-chat" }, { forUpdate: false }),
    ).toThrow(/name is required/i);
    expect(
      prepareCodePayload(
        { name: "Coder", model: "deepseek-chat" },
        { forUpdate: false },
      ),
    ).toEqual({
      name: "Coder",
      model: "deepseek-chat",
      tools: [{ type: "agent_toolset_20260401" }],
    });
    expect(
      prepareCodePayload(
        { name: "Coder", model: "deepseek-chat", tools: [] },
        { forUpdate: false },
      ),
    ).toEqual({ name: "Coder", model: "deepseek-chat", tools: [] });
  });

  it("emits only Managed Agent fields when editing a standard agent", () => {
    const agent = sampleAgent({
      mcp_servers: [],
    });
    const form = agentToForm(agent);
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload).not.toHaveProperty("_oma");
    expect(payload).not.toHaveProperty("runtime_binding");
    expect(payload).not.toHaveProperty("enable_general_subagent");
    expect(payload).not.toHaveProperty("type");
    expect(payload).not.toHaveProperty("created_at");
    expect(payload).not.toHaveProperty("updated_at");
  });

  it("round-trips typed OpenMA fields and emits explicit clears", () => {
    const agent = sampleAgent({
      _oma: {
        aux_model: { id: "deepseek-chat", speed: "fast" },
        appendable_prompts: ["prompt_review", "prompt_security"],
        harness: "pi",
      },
    });
    const form = agentToForm(agent);

    expect(form.auxiliaryModel).toBe("deepseek-chat");
    expect(form.auxiliaryModelSpeed).toBe("fast");
    expect(form.appendablePrompts).toEqual([
      "prompt_review",
      "prompt_security",
    ]);

    form.auxiliaryModel = "";
    form.auxiliaryModelSpeed = "";
    form.appendablePrompts = [];
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload._oma).toEqual({
      aux_model: null,
      appendable_prompts: [],
      harness: "pi",
    });
  });
});
