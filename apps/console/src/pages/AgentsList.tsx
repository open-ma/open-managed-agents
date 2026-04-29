import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { AGENT_TEMPLATES, type AgentTemplate } from "../data/templates";
import yaml from "js-yaml";
import type { ModelCard } from "@open-managed-agents/api-types";

interface Agent {
  id: string; name: string; model: string | { id: string; speed?: string };
  system?: string; harness?: string; version: number;
  created_at: string; updated_at?: string; archived_at?: string;
  description?: string; skills?: unknown[]; mcp_servers?: unknown[]; callable_agents?: unknown[];
}

interface McpEntry { name: string; type: string; url: string }
interface SkillEntry { type: "anthropic" | "custom"; skill_id: string; version?: string }
interface CallableEntry { type: "agent"; id: string; version: number }

const ANTHROPIC_SKILLS = [
  { id: "xlsx", label: "Excel (xlsx)" },
  { id: "pdf", label: "PDF" },
  { id: "pptx", label: "PowerPoint (pptx)" },
  { id: "docx", label: "Word (docx)" },
];

const INITIAL_FORM = {
  name: "", model: "", system: "", description: "",
  modelCardId: "",
  mcpServers: [] as McpEntry[],
  skills: [] as SkillEntry[],
  callableAgents: [] as CallableEntry[],
  // When set, agent uses harness:"acp-proxy" — its loop runs on a user-
  // registered local runtime via `oma bridge daemon` instead of OMA's cloud
  // SessionDO loop. Both fields must be set together; partial = fall back to
  // default cloud agent.
  runtimeId: "",
  acpAgentId: "claude-code-acp",
  /** Local skill ids to HIDE from this agent's ACP child. Empty = all
   *  detected local skills are visible (the daemon's default). */
  localSkillBlocklist: [] as string[],
};

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Array<{
    id: string;
    hostname: string;
    status: string;
    agents: Array<{ id: string }>;
    /** Skills daemon detected locally on the user's machine, keyed by
     *  acp agent id. Source for the blocklist multi-select that appears
     *  when the user picks an acp agent. */
    local_skills?: Record<string, Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>>;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [createError, setCreateError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [tab, setTab] = useState<"basic" | "skills" | "mcp" | "agents">("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ data: Agent[] }>(`/v1/agents?limit=200${showArchived ? "&include_archived=true" : ""}`);
      setAgents(data.data);
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200");
      setAllAgents(all.data);
      try {
        const sk = await api<{ data: Array<{ id: string; name: string; description: string }> }>("/v1/skills");
        setCustomSkills(sk.data);
      } catch {}
      try {
        const mc = await api<{ data: ModelCard[] }>("/v1/model_cards");
        setModelCards(mc.data);
      } catch {}
      try {
        const rt = await api<{ runtimes: Array<{ id: string; hostname: string; status: string; agents: Array<{ id: string }> }> }>("/v1/runtimes");
        setRuntimes(rt.runtimes);
      } catch {}
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, [showArchived]);

  const create = async () => {
    setCreateError("");
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        model: form.model,
        system: form.system || undefined,
        description: form.description || undefined,
        tools: [{ type: "agent_toolset_20260401" }],
      };
      if (form.modelCardId) payload.model_card_id = form.modelCardId;
      if (form.mcpServers.length) payload.mcp_servers = form.mcpServers;
      if (form.skills.length) payload.skills = form.skills;
      if (form.callableAgents.length) payload.callable_agents = form.callableAgents;
      // Local-runtime agent: opt into acp-proxy harness when both runtimeId
      // and acpAgentId are set. Partial config silently falls back to the
      // default cloud loop — same semantics as the CLI flag pair.
      if (form.runtimeId && form.acpAgentId) {
        payload.harness = "acp-proxy";
        payload.runtime_binding = {
          runtime_id: form.runtimeId,
          acp_agent_id: form.acpAgentId,
          ...(form.localSkillBlocklist.length > 0
            ? { local_skill_blocklist: form.localSkillBlocklist }
            : {}),
        };
      }

      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeCreate();
      nav(`/agents/${agent.id}`);
    } catch (e: any) {
      setCreateError(e?.message || "Failed to create agent");
    }
  };

  const modelStr = (m: Agent["model"]) => typeof m === "string" ? m : m?.id || "";

  const addMcp = () => setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "sse", url: "" }] });
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) => setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  const toggleAnthropicSkill = (skillId: string) => {
    const exists = form.skills.find(s => s.type === "anthropic" && s.skill_id === skillId);
    if (exists) {
      setForm({ ...form, skills: form.skills.filter(s => !(s.type === "anthropic" && s.skill_id === skillId)) });
    } else {
      setForm({ ...form, skills: [...form.skills, { type: "anthropic", skill_id: skillId }] });
    }
  };
  const addCustomSkill = () => setForm({ ...form, skills: [...form.skills, { type: "custom", skill_id: "", version: "latest" }] });
  const updateCustomSkill = (i: number, field: string, val: string) => {
    const updated = [...form.skills];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, skills: updated });
  };
  const removeSkill = (i: number) => setForm({ ...form, skills: form.skills.filter((_, j) => j !== i) });

  const addCallable = (agentId: string) => {
    if (form.callableAgents.find(c => c.id === agentId)) return;
    setForm({ ...form, callableAgents: [...form.callableAgents, { type: "agent", id: agentId, version: 1 }] });
  };
  const removeCallable = (i: number) => setForm({ ...form, callableAgents: form.callableAgents.filter((_, j) => j !== i) });

  const selectTemplate = (tmpl: AgentTemplate) => {
    if (tmpl.id === "blank") {
      setForm({ ...INITIAL_FORM });
    } else {
      setForm({
        ...INITIAL_FORM,
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        mcpServers: tmpl.mcpServers.map(m => ({ ...m })),
        skills: tmpl.skills.map(s => ({ ...s } as SkillEntry)),
      });
    }
    setCreateStep("form");
    setTab("basic");
  };

  const closeCreate = () => {
    setShowCreate(false);
    setCreateStep("template");
    setTemplateSearch("");
    setForm({ ...INITIAL_FORM });
    setTab("basic");
    setCreateError("");
    setCreateMode("form");
    setCodeValue("");
  };

  // Convert current form state to a config object
  const formToConfig = () => {
    const config: Record<string, unknown> = {
      name: form.name,
      model: form.model,
    };
    if (form.system) config.system = form.system;
    if (form.description) config.description = form.description;
    config.tools = [{ type: "agent_toolset_20260401" }];
    if (form.mcpServers.length) config.mcp_servers = form.mcpServers;
    if (form.skills.length) config.skills = form.skills;
    if (form.callableAgents.length) config.callable_agents = form.callableAgents;
    return config;
  };

  // Switch between form/yaml/json modes
  const switchMode = (mode: "form" | "yaml" | "json") => {
    if (mode === createMode) return;
    if (createMode === "form") {
      // form → code: serialize current form
      const config = formToConfig();
      setCodeValue(mode === "yaml" ? yaml.dump(config, { lineWidth: -1 }) : JSON.stringify(config, null, 2));
    } else if (mode === "form") {
      // code → form: try to parse back (best-effort, may lose data)
      try {
        const parsed = createMode === "yaml" ? yaml.load(codeValue) as Record<string, unknown> : JSON.parse(codeValue);
        const rb = parsed.runtime_binding as { runtime_id?: string; acp_agent_id?: string; local_skill_blocklist?: string[] } | undefined;
        setForm({
          ...INITIAL_FORM,
          name: String(parsed.name || ""),
          // Paste-mode fallback: if the pasted config has no model field,
          // claude-sonnet-4-6 is a real, current Anthropic model id (not
          // a placeholder), so it's a reasonable default. The form
          // dropdown does its own dynamic option set from modelCards.
          model: String(parsed.model || "claude-sonnet-4-6"),
          system: String(parsed.system || ""),
          description: String(parsed.description || ""),
          mcpServers: Array.isArray(parsed.mcp_servers) ? parsed.mcp_servers as McpEntry[] : [],
          skills: Array.isArray(parsed.skills) ? parsed.skills as SkillEntry[] : [],
          callableAgents: Array.isArray(parsed.callable_agents) ? parsed.callable_agents as CallableEntry[] : [],
          runtimeId: rb?.runtime_id ?? "",
          acpAgentId: rb?.acp_agent_id ?? "claude-code-acp",
          localSkillBlocklist: Array.isArray(rb?.local_skill_blocklist) ? rb.local_skill_blocklist : [],
        });
      } catch { /* keep current form if parse fails */ }
    } else {
      // yaml ↔ json: convert between formats
      try {
        const parsed = createMode === "yaml" ? yaml.load(codeValue) : JSON.parse(codeValue);
        setCodeValue(mode === "yaml" ? yaml.dump(parsed, { lineWidth: -1 }) : JSON.stringify(parsed, null, 2));
      } catch { /* keep current value if parse fails */ }
    }
    setCreateMode(mode);
  };

  // Create agent from code editor
  const createFromCode = async () => {
    setCreateError("");
    try {
      const parsed = createMode === "yaml"
        ? yaml.load(codeValue) as Record<string, unknown>
        : JSON.parse(codeValue);
      if (!parsed.name) { setCreateError("name is required"); return; }
      if (!parsed.tools) parsed.tools = [{ type: "agent_toolset_20260401" }];
      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      closeCreate();
      nav(`/agents/${agent.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invalid config";
      setCreateError(msg);
    }
  };

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(t =>
        t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
        t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
        t.tags.some(tag => tag.toLowerCase().includes(templateSearch.toLowerCase()))
      )
    : AGENT_TEMPLATES;

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";
  const tabCls = (t: string) => `px-3 py-1.5 text-sm rounded-md transition-colors ${tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"}`;

  const [search, setSearch] = useState("");

  const displayed = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Agents</h1>
          <p className="text-fg-muted text-sm">Create and manage autonomous agents.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover transition-colors">
          + New agent
        </button>
      </div>

      <div className="flex items-center gap-4 mb-4">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Go to agent ID..."
            className="border border-border rounded-md pl-8 pr-3 py-1.5 text-sm bg-bg text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none transition-colors w-56"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="rounded accent-brand" />
          Show archived
        </label>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg></div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">{search ? "No matching agents" : "No agents yet"}</p>
          <p className="text-sm">{search ? "Try a different search term." : "Create your first agent to get started."}</p>
          {!search && <button onClick={() => nav("/")} className="mt-3 text-sm text-brand hover:underline">Get started with the quickstart guide →</button>}
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs font-medium uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">ID</th>
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Model</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((a) => (
                <tr key={a.id} onClick={() => nav(`/agents/${a.id}`)}
                  className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted truncate max-w-[180px]" title={a.id}>{a.id}</td>
                  <td className="px-4 py-3 font-medium text-fg">{a.name}</td>
                  <td className="px-4 py-3 text-fg-muted">{modelStr(a.model)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${a.archived_at ? "bg-bg-surface text-fg-subtle" : "bg-success-subtle text-success"}`}>
                      {a.archived_at ? "archived" : "active"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-bg-overlay flex items-center justify-center z-50" onClick={closeCreate}>
          <div className="bg-bg rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

            {/* Template selection step */}
            {createStep === "template" && (
              <>
                <div className="px-6 pt-6 pb-4 border-b border-border">
                  <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
                  <p className="text-sm text-fg-muted mt-1">Start from a template or build from scratch.</p>
                  <input
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    className={`${inputCls} mt-3`}
                    placeholder="Search templates..."
                  />
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4">
                  <div className="grid grid-cols-2 gap-3">
                    {filteredTemplates.map((tmpl) => (
                      <button
                        key={tmpl.id}
                        onClick={() => selectTemplate(tmpl)}
                        className="text-left border border-border rounded-lg p-4 hover:border-brand hover:bg-bg-surface transition-all"
                      >
                        <div className="font-medium text-sm text-fg">{tmpl.name}</div>
                        <div className="text-xs text-fg-muted mt-1 line-clamp-2">{tmpl.description}</div>
                        {tmpl.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tmpl.tags.map((tag) => (
                              <span key={tag} className="px-1.5 py-0.5 bg-bg-surface text-fg-muted rounded text-[10px]">{tag}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                  {filteredTemplates.length === 0 && (
                    <div className="text-center py-8 text-fg-subtle text-sm">No templates match your search.</div>
                  )}
                </div>
                <div className="px-6 py-4 border-t border-border flex justify-end">
                  <button onClick={closeCreate} className="px-4 py-2 text-sm text-fg-muted hover:text-fg">Cancel</button>
                </div>
              </>
            )}

            {/* Form step */}
            {createStep === "form" && (
              <>
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center justify-between mb-1">
                <button onClick={() => { setCreateStep("template"); setTemplateSearch(""); setCreateMode("form"); }} className="text-sm text-fg-subtle hover:text-fg transition-colors">&larr; Templates</button>
                <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
                  {(["form", "yaml", "json"] as const).map((m) => (
                    <button key={m} onClick={() => switchMode(m)}
                      className={`px-2 py-1 text-xs rounded transition-colors ${createMode === m ? "bg-bg text-fg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>
                      {m === "form" ? "Form" : m.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
              {createMode === "form" && (
              <div className="flex gap-1 mt-3">
                <button onClick={() => setTab("basic")} className={tabCls("basic")}>Basic</button>
                <button onClick={() => setTab("skills")} className={tabCls("skills")}>
                  Skills {form.skills.length > 0 && <span className="ml-1 text-xs opacity-60">({form.skills.length})</span>}
                </button>
                <button onClick={() => setTab("mcp")} className={tabCls("mcp")}>
                  MCP Servers {form.mcpServers.length > 0 && <span className="ml-1 text-xs opacity-60">({form.mcpServers.length})</span>}
                </button>
                <button onClick={() => setTab("agents")} className={tabCls("agents")}>
                  Multi-Agent {form.callableAgents.length > 0 && <span className="ml-1 text-xs opacity-60">({form.callableAgents.length})</span>}
                </button>
              </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Code editor mode (YAML/JSON) */}
              {createMode !== "form" && (
                <div className="space-y-3 h-full flex flex-col">
                  {createError && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{createError}</div>}
                  <textarea
                    value={codeValue}
                    onChange={(e) => setCodeValue(e.target.value)}
                    className={`${inputCls} flex-1 resize-none font-mono text-xs leading-relaxed min-h-[300px]`}
                    spellCheck={false}
                  />
                </div>
              )}
              {/* Form mode */}
              {createMode === "form" && tab === "basic" && (
                <div className="space-y-3">
                  {createError && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{createError}</div>}
                  <div>
                    <label className="text-sm text-fg-muted block mb-1">Name *</label>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Coding Assistant" />
                  </div>
                  <div>
                    <label className="text-sm text-fg-muted block mb-1">Model</label>
                    {/* Options derived dynamically from the user's model_cards.
                        The previous hard-coded list (sonnet-4-6 / opus-4-6 /
                        haiku-4-5) silently embedded a non-existent model
                        (opus-4-6 was retired; current Opus is 4-7) and stayed
                        in sync with no source of truth. Now the dropdown
                        reflects exactly what cards are configured — anyone
                        picking a model has somewhere to back the call.
                        Cloud agents need at least one model_card to create;
                        local-runtime agents skip this section entirely (the
                        ACP child brings its own credentials). */}
                    <select
                      value={form.model}
                      onChange={(e) => setForm({ ...form, model: e.target.value, modelCardId: "" })}
                      className={inputCls}
                      disabled={modelCards.length === 0}
                    >
                      {modelCards.length === 0 && <option value="">— add a model card first —</option>}
                      {Array.from(new Set(modelCards.map(mc => mc.model_id))).map(modelId => (
                        <option key={modelId} value={modelId}>{modelId}</option>
                      ))}
                    </select>
                  </div>
                  {modelCards.length > 0 && (
                    <div>
                      <label className="text-sm text-fg-muted block mb-1">Model Card</label>
                      <select
                        value={form.modelCardId}
                        onChange={(e) => {
                          const cardId = e.target.value;
                          setForm({ ...form, modelCardId: cardId });
                          if (cardId) {
                            const card = modelCards.find(mc => mc.id === cardId);
                            if (card) setForm(f => ({ ...f, modelCardId: cardId, model: card.model_id }));
                          }
                        }}
                        className={inputCls}
                      >
                        <option value="">Auto-detect by model ID</option>
                        {modelCards.map(mc => (
                          <option key={mc.id} value={mc.id}>{mc.name} ({mc.model_id}) — ****{mc.api_key_preview}</option>
                        ))}
                      </select>
                      <p className="text-xs text-fg-subtle mt-1">Select which API credentials to use for this agent.</p>
                    </div>
                  )}
                  {modelCards.length === 0 && (
                    <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                      No model cards configured. Cloud agents need at least one card to provide LLM credentials.{" "}
                      <a href="/model-cards" className="underline hover:text-fg-muted">Add one</a>.
                    </p>
                  )}
                  <div>
                    <label className="text-sm text-fg-muted block mb-1">Description</label>
                    <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="A coding assistant that writes clean code..." />
                  </div>
                  <div>
                    <label className="text-sm text-fg-muted block mb-1">System Prompt</label>
                    <textarea value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} rows={5} className={`${inputCls} resize-none font-mono text-xs leading-relaxed`} placeholder="You are a helpful assistant..." />
                  </div>
                  {/* Local Runtime — bind agent's loop to a user-registered
                      machine instead of OMA's cloud SessionDO. The "no
                      runtime" option is the default cloud agent. */}
                  <div>
                    <label className="text-sm text-fg-muted block mb-1">
                      Local Runtime
                      <span className="ml-1 text-xs text-fg-subtle">(optional)</span>
                    </label>
                    {runtimes.length === 0 ? (
                      <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                        No runtimes registered.{" "}
                        <a href="/runtimes" className="underline hover:text-fg-muted">Connect a machine</a>{" "}
                        to delegate this agent's loop to your own Claude Code (or other ACP) child.
                      </p>
                    ) : (
                      <>
                        <select
                          value={form.runtimeId}
                          onChange={(e) => {
                            const rid = e.target.value;
                            // Auto-pick the first detected ACP agent on the
                            // chosen runtime — user doesn't have to know what
                            // strings the daemon's manifest emits. Falls back
                            // to whatever was set if the runtime has none
                            // (rare; daemon detection list would be empty).
                            const first = runtimes.find((r) => r.id === rid)?.agents?.[0]?.id;
                            setForm({
                              ...form,
                              runtimeId: rid,
                              acpAgentId: rid && first ? first : form.acpAgentId,
                            });
                          }}
                          className={inputCls}
                        >
                          <option value="">— Cloud (run on OMA) —</option>
                          {runtimes.map((r) => (
                            <option key={r.id} value={r.id} disabled={r.status !== "online"}>
                              {r.hostname} ({r.status}{r.status === "online" && r.agents.length ? ` · ${r.agents.length} agents` : ""})
                            </option>
                          ))}
                        </select>
                        {form.runtimeId && (
                          <div className="mt-2">
                            <label className="text-xs text-fg-subtle block mb-1">ACP agent on this machine</label>
                            <select
                              value={form.acpAgentId}
                              onChange={(e) => setForm({ ...form, acpAgentId: e.target.value, localSkillBlocklist: [] })}
                              className={inputCls}
                            >
                              {(runtimes.find((r) => r.id === form.runtimeId)?.agents ?? []).map((a) => (
                                <option key={a.id} value={a.id}>{a.id}</option>
                              ))}
                            </select>
                            <p className="text-xs text-fg-subtle mt-1">
                              Each turn spawns this ACP child on the runtime. Model + skills come from the daemon-fetched bundle.
                            </p>
                            {/* Local-skill blocklist — multi-select fed by what the
                                daemon reported in hello.local_skills[acpAgentId].
                                Default = all visible (empty blocklist). User unchecks
                                to hide a global skill from this agent. */}
                            {(() => {
                              const localSkills =
                                runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[form.acpAgentId] ?? [];
                              if (!localSkills.length) return null;
                              const allowed = new Set(localSkills.map((s) => s.id))
                              for (const id of form.localSkillBlocklist) allowed.delete(id);
                              return (
                                <div className="mt-3 border border-border rounded-md p-2.5 bg-bg-surface">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-xs text-fg-muted">
                                      Local skills ({allowed.size}/{localSkills.length} visible)
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setForm({ ...form, localSkillBlocklist: [] })}
                                      className="text-[10px] text-fg-subtle hover:text-fg underline"
                                    >
                                      reset
                                    </button>
                                  </div>
                                  <div className="space-y-0.5 max-h-40 overflow-y-auto">
                                    {localSkills.map((s) => {
                                      const blocked = form.localSkillBlocklist.includes(s.id);
                                      return (
                                        <label
                                          key={s.id}
                                          className="flex items-start gap-2 text-xs cursor-pointer hover:bg-bg rounded px-1.5 py-0.5"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={!blocked}
                                            onChange={(e) => {
                                              const next = new Set(form.localSkillBlocklist);
                                              if (e.target.checked) next.delete(s.id);
                                              else next.add(s.id);
                                              setForm({ ...form, localSkillBlocklist: [...next] });
                                            }}
                                            className="mt-0.5 accent-brand"
                                          />
                                          <span className="font-mono text-fg flex-shrink-0">{s.id}</span>
                                          <span className="text-fg-subtle">
                                            ({s.source ?? "global"}{s.source_label ? `:${s.source_label}` : ""})
                                          </span>
                                          {s.name && s.name !== s.id && (
                                            <span className="text-fg-muted truncate">— {s.name}</span>
                                          )}
                                        </label>
                                      );
                                    })}
                                  </div>
                                  <p className="text-[10px] text-fg-subtle mt-1.5">
                                    Unchecked = hidden from the ACP child (daemon won't symlink the dir into the spawn cwd).
                                  </p>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Skills tab */}
              {createMode === "form" && tab === "skills" && (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-fg block mb-2">Anthropic Skills</label>
                    <div className="grid grid-cols-2 gap-2">
                      {ANTHROPIC_SKILLS.map((s) => {
                        const active = form.skills.some(sk => sk.type === "anthropic" && sk.skill_id === s.id);
                        return (
                          <button key={s.id} onClick={() => toggleAnthropicSkill(s.id)}
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm text-left transition-all ${active ? "border-brand bg-brand text-brand-fg" : "border-border hover:border-border-strong"}`}>
                            <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${active ? "bg-brand-fg text-brand border-brand-fg" : "border-border-strong"}`}>
                              {active && "✓"}
                            </span>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-fg block mb-2">Custom Skills</label>
                    {customSkills.length > 0 ? (
                      <div className="space-y-2">
                        {customSkills.map((cs) => {
                          const active = form.skills.some(sk => sk.type === "custom" && sk.skill_id === cs.id);
                          return (
                            <button key={cs.id}
                              onClick={() => {
                                if (active) {
                                  setForm({ ...form, skills: form.skills.filter(sk => !(sk.type === "custom" && sk.skill_id === cs.id)) });
                                } else {
                                  setForm({ ...form, skills: [...form.skills, { type: "custom", skill_id: cs.id, version: "latest" }] });
                                }
                              }}
                              className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md border text-sm text-left transition-all ${active ? "border-brand bg-brand text-brand-fg" : "border-border hover:border-border-strong"}`}>
                              <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs shrink-0 ${active ? "bg-brand-fg text-brand border-brand-fg" : "border-border-strong"}`}>
                                {active && "✓"}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium">{cs.name}</div>
                                <div className={`text-xs truncate ${active ? "text-brand-fg/70" : "text-fg-subtle"}`}>{cs.description}</div>
                              </div>
                              <span className={`text-xs font-mono shrink-0 ${active ? "text-brand-fg/60" : "text-fg-subtle"}`}>{cs.id}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-fg-subtle">No custom skills registered. <a href="/skills" className="underline hover:text-fg-muted">Create one</a>.</p>
                    )}
                  </div>
                </div>
              )}

              {/* MCP tab */}
              {createMode === "form" && tab === "mcp" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-fg">MCP Servers</label>
                    <button onClick={addMcp} className="text-xs text-fg-muted hover:text-fg transition-colors">+ Add server</button>
                  </div>
                  {form.mcpServers.map((mcp, i) => (
                    <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-fg-muted block mb-0.5">Name</label>
                          <input value={mcp.name} onChange={(e) => updateMcp(i, "name", e.target.value)} className={inputCls} placeholder="github" />
                        </div>
                        <div className="w-24">
                          <label className="text-xs text-fg-muted block mb-0.5">Type</label>
                          <select value={mcp.type} onChange={(e) => updateMcp(i, "type", e.target.value)} className={inputCls}>
                            <option>sse</option>
                            <option>stdio</option>
                          </select>
                        </div>
                        <button onClick={() => removeMcp(i)} className="self-end px-2 py-2 text-fg-subtle hover:text-danger transition-colors">×</button>
                      </div>
                      <div>
                        <label className="text-xs text-fg-muted block mb-0.5">URL</label>
                        <input value={mcp.url} onChange={(e) => updateMcp(i, "url", e.target.value)} className={inputCls} placeholder="https://mcp.github.com/sse" />
                      </div>
                    </div>
                  ))}
                  {form.mcpServers.length === 0 && (
                    <div className="text-center py-8 text-fg-subtle">
                      <p className="text-sm">No MCP servers configured.</p>
                      <p className="text-xs mt-1">MCP servers provide external tools via the Model Context Protocol.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Multi-agent tab */}
              {createMode === "form" && tab === "agents" && (
                <div className="space-y-3">
                  <label className="text-sm font-medium text-fg block">Callable Agents</label>
                  <p className="text-xs text-fg-subtle mb-2">Select agents that this agent can delegate tasks to.</p>

                  {form.callableAgents.map((ca, i) => {
                    const agentInfo = allAgents.find(a => a.id === ca.id);
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg">
                        <div className="flex-1">
                          <div className="text-sm font-medium text-fg">{agentInfo?.name || ca.id}</div>
                          <div className="text-xs text-fg-subtle font-mono">{ca.id}</div>
                        </div>
                        <button onClick={() => removeCallable(i)} className="px-2 text-fg-subtle hover:text-danger transition-colors">×</button>
                      </div>
                    );
                  })}

                  <div>
                    <label className="text-xs text-fg-muted block mb-1">Add agent</label>
                    <select onChange={(e) => { if (e.target.value) addCallable(e.target.value); e.target.value = ""; }} className={inputCls}>
                      <option value="">Select an agent...</option>
                      {allAgents
                        .filter(a => !form.callableAgents.find(c => c.id === a.id))
                        .map(a => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
                    </select>
                  </div>

                  {form.callableAgents.length === 0 && allAgents.length === 0 && (
                    <p className="text-xs text-fg-subtle">Create other agents first to enable multi-agent delegation.</p>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border flex justify-between items-center">
              <div className="text-xs text-fg-subtle">
                {createMode === "form" && (
                  <>
                    {form.skills.length > 0 && <span className="mr-3">{form.skills.length} skills</span>}
                    {form.mcpServers.length > 0 && <span className="mr-3">{form.mcpServers.length} MCP</span>}
                    {form.callableAgents.length > 0 && <span>{form.callableAgents.length} agents</span>}
                  </>
                )}
                {createMode !== "form" && <span>{createMode.toUpperCase()} editor</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={closeCreate} className="px-4 py-2 text-sm text-fg-muted hover:text-fg">Cancel</button>
                {createMode === "form" ? (
                  <button onClick={create} disabled={!form.name} className="px-5 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">Create Agent</button>
                ) : (
                  <button onClick={createFromCode} disabled={!codeValue.trim()} className="px-5 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors">Create Agent</button>
                )}
              </div>
            </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
