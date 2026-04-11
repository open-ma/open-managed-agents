import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { AGENT_TEMPLATES, type AgentTemplate } from "../data/templates";

interface Agent {
  id: string; name: string; model: string | { id: string; speed?: string };
  system?: string; harness?: string; version: number;
  created_at: string; updated_at?: string; archived_at?: string;
  description?: string; skills?: unknown[]; mcp_servers?: unknown[]; callable_agents?: unknown[];
}

interface ModelCard {
  id: string; name: string; provider: string; model_id: string;
  api_key_preview?: string; base_url?: string; is_default?: boolean;
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
  name: "", model: "claude-sonnet-4-6", system: "", description: "",
  modelCardId: "",
  mcpServers: [] as McpEntry[],
  skills: [] as SkillEntry[],
  callableAgents: [] as CallableEntry[],
};

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [createError, setCreateError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [tab, setTab] = useState<"basic" | "skills" | "mcp" | "agents">("basic");

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ data: Agent[] }>(`/v1/agents?limit=200${showArchived ? "&include_archived=true" : ""}`);
      setAgents(data.data);
      // Load all agents for callable_agents picker
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200");
      setAllAgents(all.data);
      // Load custom skills
      try {
        const sk = await api<{ data: Array<{ id: string; name: string; description: string }> }>("/v1/skills");
        setCustomSkills(sk.data);
      } catch {}
      // Load model cards
      try {
        const mc = await api<{ data: ModelCard[] }>("/v1/model_cards");
        setModelCards(mc.data);
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

  // --- MCP helpers ---
  const addMcp = () => setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "sse", url: "" }] });
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) => setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  // --- Skill helpers ---
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

  // --- Callable agent helpers ---
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
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        modelCardId: "",
        mcpServers: tmpl.mcpServers.map(m => ({ ...m })),
        skills: tmpl.skills.map(s => ({ ...s } as SkillEntry)),
        callableAgents: [],
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
  };

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(t =>
        t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
        t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
        t.tags.some(tag => tag.toLowerCase().includes(templateSearch.toLowerCase()))
      )
    : AGENT_TEMPLATES;

  const inputCls = "w-full border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-stone-400 transition-colors";
  const tabCls = (t: string) => `px-3 py-1.5 text-sm rounded-lg transition-colors ${tab === t ? "bg-stone-900 text-white" : "text-stone-500 hover:bg-stone-100"}`;

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-stone-500 text-sm">Create and manage autonomous agents.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors">
          + New agent
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm text-stone-500 cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="rounded" />
          Show archived
        </label>
      </div>

      {loading ? (
        <div className="text-stone-400 text-sm py-8 text-center">Loading...</div>
      ) : agents.length === 0 ? (
        <div className="text-center py-16 text-stone-400">
          <p className="text-lg mb-1">No agents yet</p>
          <p className="text-sm">Create your first agent to get started.</p>
        </div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-100/60 text-stone-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Model</th>
                <th className="text-left px-4 py-2.5">Version</th>
                <th className="text-left px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} onClick={() => nav(`/agents/${a.id}`)}
                  className="border-t border-stone-100 hover:bg-stone-50 cursor-pointer transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-stone-400 font-mono">{a.id}</div>
                  </td>
                  <td className="px-4 py-3 text-stone-600">{modelStr(a.model)}</td>
                  <td className="px-4 py-3 text-stone-600">v{a.version}</td>
                  <td className="px-4 py-3 text-stone-500">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeCreate}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

            {/* Template selection step */}
            {createStep === "template" && (
              <>
                <div className="px-6 pt-6 pb-4 border-b border-stone-100">
                  <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">New Agent</h2>
                  <p className="text-sm text-stone-500 mt-1">Start from a template or build from scratch.</p>
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
                        className="text-left border border-stone-200 rounded-lg p-4 hover:border-stone-400 hover:bg-stone-50 transition-all"
                      >
                        <div className="font-medium text-sm">{tmpl.name}</div>
                        <div className="text-xs text-stone-500 mt-1 line-clamp-2">{tmpl.description}</div>
                        {tmpl.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tmpl.tags.map((tag) => (
                              <span key={tag} className="px-1.5 py-0.5 bg-stone-100 text-stone-500 rounded text-[10px]">{tag}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                  {filteredTemplates.length === 0 && (
                    <div className="text-center py-8 text-stone-400 text-sm">No templates match your search.</div>
                  )}
                </div>
                <div className="px-6 py-4 border-t border-stone-100 flex justify-end">
                  <button onClick={closeCreate} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900">Cancel</button>
                </div>
              </>
            )}

            {/* Form step */}
            {createStep === "form" && (
              <>
            <div className="px-6 pt-6 pb-4 border-b border-stone-100">
              <div className="flex items-center gap-2 mb-1">
                <button onClick={() => { setCreateStep("template"); setTemplateSearch(""); }} className="text-sm text-stone-400 hover:text-stone-700 transition-colors">&larr; Templates</button>
              </div>
              <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">New Agent</h2>
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
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Basic tab */}
              {tab === "basic" && (
                <div className="space-y-3">
                  {createError && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{createError}</div>}
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">Name *</label>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Coding Assistant" />
                  </div>
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">Model</label>
                    <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value, modelCardId: "" })} className={inputCls}>
                      <option>claude-sonnet-4-6</option>
                      <option>claude-opus-4-6</option>
                      <option>claude-haiku-4-5</option>
                      {/* Show unique model_ids from model cards not already in the static list */}
                      {modelCards
                        .filter(mc => !["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"].includes(mc.model_id))
                        .filter((mc, i, arr) => arr.findIndex(m => m.model_id === mc.model_id) === i)
                        .map(mc => <option key={mc.model_id} value={mc.model_id}>{mc.model_id}</option>)}
                    </select>
                  </div>
                  {modelCards.length > 0 && (
                    <div>
                      <label className="text-sm text-stone-600 block mb-1">Model Card</label>
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
                      <p className="text-xs text-stone-400 mt-1">Select which API credentials to use for this agent.</p>
                    </div>
                  )}
                  {modelCards.length === 0 && (
                    <p className="text-xs text-stone-400 bg-stone-50 px-3 py-2 rounded-lg">
                      No model cards configured. Agents will use the environment API key.{" "}
                      <a href="/model-cards" className="underline hover:text-stone-600">Add one</a>.
                    </p>
                  )}
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">Description</label>
                    <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="A coding assistant that writes clean code..." />
                  </div>
                  <div>
                    <label className="text-sm text-stone-600 block mb-1">System Prompt</label>
                    <textarea value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} rows={5} className={`${inputCls} resize-none font-[family-name:var(--font-mono)] text-xs leading-relaxed`} placeholder="You are a helpful assistant..." />
                  </div>
                </div>
              )}

              {/* Skills tab */}
              {tab === "skills" && (
                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-stone-700 block mb-2">Anthropic Skills</label>
                    <div className="grid grid-cols-2 gap-2">
                      {ANTHROPIC_SKILLS.map((s) => {
                        const active = form.skills.some(sk => sk.type === "anthropic" && sk.skill_id === s.id);
                        return (
                          <button key={s.id} onClick={() => toggleAnthropicSkill(s.id)}
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm text-left transition-all ${active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 hover:border-stone-300"}`}>
                            <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${active ? "bg-white text-stone-900 border-white" : "border-stone-300"}`}>
                              {active && "✓"}
                            </span>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-stone-700 block mb-2">Custom Skills</label>
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
                              className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border text-sm text-left transition-all ${active ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 hover:border-stone-300"}`}>
                              <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs shrink-0 ${active ? "bg-white text-stone-900 border-white" : "border-stone-300"}`}>
                                {active && "✓"}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium">{cs.name}</div>
                                <div className={`text-xs truncate ${active ? "text-stone-300" : "text-stone-400"}`}>{cs.description}</div>
                              </div>
                              <span className={`text-xs font-mono shrink-0 ${active ? "text-stone-400" : "text-stone-300"}`}>{cs.id}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-stone-400">No custom skills registered. <a href="/skills" className="underline hover:text-stone-600">Create one</a>.</p>
                    )}
                  </div>
                </div>
              )}

              {/* MCP tab */}
              {tab === "mcp" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-stone-700">MCP Servers</label>
                    <button onClick={addMcp} className="text-xs text-stone-500 hover:text-stone-900 transition-colors">+ Add server</button>
                  </div>
                  {form.mcpServers.map((mcp, i) => (
                    <div key={i} className="border border-stone-200 rounded-lg p-3 space-y-2">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-stone-500 block mb-0.5">Name</label>
                          <input value={mcp.name} onChange={(e) => updateMcp(i, "name", e.target.value)} className={inputCls} placeholder="github" />
                        </div>
                        <div className="w-24">
                          <label className="text-xs text-stone-500 block mb-0.5">Type</label>
                          <select value={mcp.type} onChange={(e) => updateMcp(i, "type", e.target.value)} className={inputCls}>
                            <option>sse</option>
                            <option>stdio</option>
                          </select>
                        </div>
                        <button onClick={() => removeMcp(i)} className="self-end px-2 py-2 text-stone-400 hover:text-red-500 transition-colors">×</button>
                      </div>
                      <div>
                        <label className="text-xs text-stone-500 block mb-0.5">URL</label>
                        <input value={mcp.url} onChange={(e) => updateMcp(i, "url", e.target.value)} className={inputCls} placeholder="https://mcp.github.com/sse" />
                      </div>
                    </div>
                  ))}
                  {form.mcpServers.length === 0 && (
                    <div className="text-center py-8 text-stone-400">
                      <p className="text-sm">No MCP servers configured.</p>
                      <p className="text-xs mt-1">MCP servers provide external tools via the Model Context Protocol.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Multi-agent tab */}
              {tab === "agents" && (
                <div className="space-y-3">
                  <label className="text-sm font-medium text-stone-700 block">Callable Agents</label>
                  <p className="text-xs text-stone-400 mb-2">Select agents that this agent can delegate tasks to.</p>

                  {form.callableAgents.map((ca, i) => {
                    const agentInfo = allAgents.find(a => a.id === ca.id);
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 border border-stone-200 rounded-lg">
                        <div className="flex-1">
                          <div className="text-sm font-medium">{agentInfo?.name || ca.id}</div>
                          <div className="text-xs text-stone-400 font-mono">{ca.id}</div>
                        </div>
                        <button onClick={() => removeCallable(i)} className="px-2 text-stone-400 hover:text-red-500 transition-colors">×</button>
                      </div>
                    );
                  })}

                  <div>
                    <label className="text-xs text-stone-500 block mb-1">Add agent</label>
                    <select onChange={(e) => { if (e.target.value) addCallable(e.target.value); e.target.value = ""; }} className={inputCls}>
                      <option value="">Select an agent...</option>
                      {allAgents
                        .filter(a => !form.callableAgents.find(c => c.id === a.id))
                        .map(a => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
                    </select>
                  </div>

                  {form.callableAgents.length === 0 && allAgents.length === 0 && (
                    <p className="text-xs text-stone-400">Create other agents first to enable multi-agent delegation.</p>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-stone-100 flex justify-between items-center">
              <div className="text-xs text-stone-400">
                {form.skills.length > 0 && <span className="mr-3">{form.skills.length} skills</span>}
                {form.mcpServers.length > 0 && <span className="mr-3">{form.mcpServers.length} MCP</span>}
                {form.callableAgents.length > 0 && <span>{form.callableAgents.length} agents</span>}
              </div>
              <div className="flex gap-2">
                <button onClick={closeCreate} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900">Cancel</button>
                <button onClick={create} disabled={!form.name} className="px-5 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40 transition-colors">Create Agent</button>
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
