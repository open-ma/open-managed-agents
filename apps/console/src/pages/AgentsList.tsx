import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useCursorList } from "../lib/useCursorList";
import { ListPage } from "../components/ListPage";
import { Select, SelectOption, SelectGroup, SelectGroupLabel } from "../components/Select";
import { Combobox } from "../components/Combobox";
import { McpServerPickerModal } from "../components/McpServerPickerModal";
import { AGENT_TEMPLATES, type AgentTemplate } from "../data/templates";
import yaml from "js-yaml";
import type { ModelCard } from "@open-managed-agents/api-types";
import { KNOWN_ACP_AGENTS, resolveKnownAgent } from "@open-managed-agents/acp-runtime/known-agents";

interface Agent {
  id: string; name: string; model: string | { id: string; speed?: string };
  system?: string; version: number;
  created_at: string; updated_at?: string; archived_at?: string;
  description?: string; skills?: unknown[]; mcp_servers?: unknown[];
  multiagent?: { type: "coordinator"; agents: Array<{type:"agent"; id:string; version:number}> } | null;
  _oma?: {
    aux_model?: { id: string; speed?: string };
    harness?: string;
    runtime_binding?: { runtime_id: string; acp_agent_id: string };
    appendable_prompts?: string[];
  };
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

// AMA spec built-in tool names — must match
// `BetaManagedAgentsAgentToolConfig.name` enum in the SDK. Source of
// truth lives in the agent_toolset_20260401 toolset; emitting unknown
// names here would still validate at the API layer but produces a tool
// the runtime never wires.
const BUILTIN_TOOLS: Array<{ name: string; label: string; description: string }> = [
  { name: "bash", label: "bash", description: "Run shell commands in the sandbox" },
  { name: "edit", label: "edit", description: "In-place file edits" },
  { name: "read", label: "read", description: "Read files from the sandbox FS" },
  { name: "write", label: "write", description: "Create or overwrite files" },
  { name: "glob", label: "glob", description: "Pattern-match file paths" },
  { name: "grep", label: "grep", description: "Search file contents" },
  { name: "web_fetch", label: "web_fetch", description: "Fetch a URL → markdown. Default for any web read." },
  { name: "web_search", label: "web_search", description: "Web search via DuckDuckGo. Default for lookups." },
  { name: "browser", label: "browser (opt-in)", description: "Heavy multi-step browser session (navigate / click / screenshot). Off by default — LLMs over-reach for it on simple lookups. Enable only when you need interactive navigation, JS-rendered SPAs, or auth flows." },
];

type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

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
  acpAgentId: "claude-agent-acp",
  /** Local skill ids to HIDE from this agent's ACP child. Empty = all
   *  detected local skills are visible (the daemon's default). */
  localSkillBlocklist: [] as string[],
  // Built-in tool policy. `agent_toolset_20260401` toolset's
  // `default_config` controls fallback enabled/permission for any
  // tool without a specific override. `toolOverrides` is a per-tool
  // 4-state: "default" (no entry emitted in configs[]), "always_allow",
  // "always_ask", or "disabled" (enabled=false). Pre-rewrite the form
  // hard-coded an empty toolset → all tools enabled + always_allow.
  toolDefaultEnabled: true,
  toolDefaultPermission: "always_allow" as "always_allow" | "always_ask",
  toolOverrides: {} as Record<string, ToolOverride>,
  // Opt-in to the built-in `general_subagent` tool. Server-side this
  // flag drives both the tool registration (apps/agent/src/harness/
  // tools.ts) and runSubAgent's reserved-id branch (session-do.ts).
  enableGeneralSubagent: false,
};

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
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
  const [, setAuxLoading] = useState(true);
  const [createError, setCreateError] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  /* Dialog accessibility ref. The create dialog stays hand-rolled (its
     template→form/yaml/json multi-step header doesn't fit the standard
     Modal), but the focus trap, scroll lock, restore-focus and Escape
     handlers below mirror what Modal does so keyboard + screen-reader
     users get the same affordances. */
  const createDialogRef = useRef<HTMLDivElement>(null);
  const createPreviousFocus = useRef<HTMLElement | null>(null);
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [tab, setTab] = useState<"basic" | "tools" | "skills" | "mcp" | "agents">("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
  const [showMcpPicker, setShowMcpPicker] = useState(false);

  // Main agents table — cursor-paginated. Filter changes (showArchived)
  // reset to page 1 automatically.
  const agentsParams = useMemo(
    () => ({ include_archived: showArchived ? "true" : undefined }),
    [showArchived],
  );
  const {
    items: agents,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: refreshAgents,
  } = useCursorList<Agent>("/v1/agents", { limit: 50, params: agentsParams });

  // Aux fetches that aren't paginated UI surfaces — refreshed on mount and
  // after agent CRUD. Pull all agents (for the callable-agents dropdown)
  // separately so it isn't constrained by the main list's page size.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200");
      setAllAgents(all.data);
      try {
        const sk = await api<{ data: Array<{ id: string; name: string; description: string }> }>("/v1/skills");
        setCustomSkills(sk.data);
      } catch {}
      try {
        const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
        setModelCards(mc.data);
      } catch {}
      try {
        const rt = await api<{ runtimes: Array<{ id: string; hostname: string; status: string; agents: Array<{ id: string }> }> }>("/v1/runtimes");
        setRuntimes(rt.runtimes);
      } catch {}
    } catch {}
    setAuxLoading(false);
  };

  useEffect(() => { loadAux(); }, []);

  // Pre-select default model card when entering the form step. (tenant_id,
  // model_id) is UNIQUE in DB, so picking a card uniquely determines the
  // model. Skip if user/paste already set model. Re-runs when modelCards
  // arrives if the dialog opened before the aux fetch.
  useEffect(() => {
    if (createStep !== "form") return;
    if (form.modelCardId || form.model) return;
    if (modelCards.length === 0) return;
    const def = modelCards.find((mc) => mc.is_default) ?? modelCards[0];
    setForm((f) => ({ ...f, modelCardId: def.id, model: def.model_id }));
    // Intentionally not depending on form.* — guards above prevent the
    // re-trigger loop and we only want to hydrate on step entry / cards arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createStep, modelCards.length]);

  // Keep refresh hook reachable for create / archive callbacks.
  void refreshAgents;

  // Serialize the form's tool-policy state into the AMA-shape
  // `tools` array. Always emits exactly one toolset entry of type
  // `agent_toolset_20260401`; per-tool overrides only land in
  // `configs[]` when they differ from the default — keeps payloads
  // minimal and edits round-trippable through the YAML/JSON view.
  const buildToolsField = () => {
    const overrides = Object.entries(form.toolOverrides)
      .filter(([, v]) => v !== "default")
      .map(([name, v]) => {
        if (v === "disabled") return { name, enabled: false };
        return {
          name,
          enabled: true,
          permission_policy: { type: v as "always_allow" | "always_ask" },
        };
      });
    // AMA spec: each entry in mcp_servers gets a corresponding mcp_toolset
    // tool that references it by name. Surface them all as always_allow
    // by default — the user already opted in by adding the server.
    const mcpToolsets = form.mcpServers
      .filter((m) => m.name)
      .map((m) => ({
        type: "mcp_toolset" as const,
        mcp_server_name: m.name,
        default_config: { permission_policy: { type: "always_allow" as const } },
      }));
    return [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: form.toolDefaultEnabled,
          permission_policy: { type: form.toolDefaultPermission },
        },
        ...(overrides.length > 0 ? { configs: overrides } : {}),
      },
      ...mcpToolsets,
    ];
  };

  const create = async () => {
    setCreateError("");
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        model: form.model,
        system: form.system || undefined,
        description: form.description || undefined,
        tools: buildToolsField(),
      };
      if (form.mcpServers.length) payload.mcp_servers = form.mcpServers;
      if (form.skills.length) payload.skills = form.skills;
      if (form.callableAgents.length) {
        payload.multiagent = { type: "coordinator", agents: form.callableAgents };
      }
      if (form.enableGeneralSubagent) {
        payload.enable_general_subagent = true;
      }
      // Local-runtime agent: opt into acp-proxy harness when both runtimeId
      // and acpAgentId are set. Partial config silently falls back to the
      // default cloud loop — same semantics as the CLI flag pair.
      if (form.runtimeId && form.acpAgentId) {
        payload._oma = {
          harness: "acp-proxy",
          runtime_binding: {
            runtime_id: form.runtimeId,
            acp_agent_id: form.acpAgentId,
            ...(form.localSkillBlocklist.length > 0
              ? { local_skill_blocklist: form.localSkillBlocklist }
              : {}),
          },
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

  const addMcp = () => setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, { name: entry.id, type: "url", url: entry.url }],
    });
  };
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
  const removeSkill = (i: number) => setForm({ ...form, skills: form.skills.filter((_, j) => j !== i) });
  void removeSkill; // referenced by future-edit affordances; keep import-time safe.

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

  // Dialog a11y — focus trap + Escape, scroll lock, focus restore on close.
  // Mirrors components/Modal.tsx behavior so this hand-rolled multi-step
  // dialog is keyboard-equivalent.
  useEffect(() => {
    if (!showCreate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeCreate(); return; }
      if (e.key !== "Tab") return;
      const el = createDialogRef.current;
      if (!el) return;
      const f = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // closeCreate is stable enough — deps kept tight to avoid re-binding
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate]);

  useEffect(() => {
    if (!showCreate) return;
    createPreviousFocus.current = document.activeElement as HTMLElement;
    const el = createDialogRef.current;
    el?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      createPreviousFocus.current?.focus();
    };
  }, [showCreate]);

  // Convert current form state to a config object
  const formToConfig = () => {
    const config: Record<string, unknown> = {
      name: form.name,
      model: form.model,
    };
    if (form.system) config.system = form.system;
    if (form.description) config.description = form.description;
    config.tools = buildToolsField();
    if (form.mcpServers.length) config.mcp_servers = form.mcpServers;
    if (form.skills.length) config.skills = form.skills;
    if (form.callableAgents.length) {
      config.multiagent = { type: "coordinator", agents: form.callableAgents };
    }
    if (form.enableGeneralSubagent) {
      config.enable_general_subagent = true;
    }
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
        // Tool policy round-trip: extract default + per-tool overrides
        // from the first agent_toolset_20260401 entry (custom tools and
        // MCP toolsets pass through untouched in YAML/JSON view but
        // can't currently be edited in the Form view — they survive
        // the round-trip via the YAML mode if the user toggled to it).
        const toolset = Array.isArray(parsed.tools)
          ? (parsed.tools as Array<Record<string, unknown>>).find(
              (t) => t?.type === "agent_toolset_20260401",
            )
          : undefined;
        const dc = (toolset?.default_config ?? {}) as {
          enabled?: boolean;
          permission_policy?: { type?: string };
        };
        const cfgs = (toolset?.configs ?? []) as Array<{
          name?: string;
          enabled?: boolean;
          permission_policy?: { type?: string };
        }>;
        const overrides: Record<string, ToolOverride> = {};
        for (const c of cfgs) {
          if (!c?.name) continue;
          if (c.enabled === false) overrides[c.name] = "disabled";
          else if (c.permission_policy?.type === "always_ask") overrides[c.name] = "always_ask";
          else if (c.permission_policy?.type === "always_allow") overrides[c.name] = "always_allow";
        }
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
          callableAgents: Array.isArray(parsed.multiagent?.agents)
            ? parsed.multiagent.agents as CallableEntry[]
            : [],
          runtimeId: rb?.runtime_id ?? "",
          acpAgentId: rb?.acp_agent_id ?? "claude-agent-acp",
          localSkillBlocklist: Array.isArray(rb?.local_skill_blocklist) ? rb.local_skill_blocklist : [],
          toolDefaultEnabled: dc.enabled ?? true,
          toolDefaultPermission: dc.permission_policy?.type === "always_ask" ? "always_ask" : "always_allow",
          toolOverrides: overrides,
          enableGeneralSubagent: parsed.enable_general_subagent === true,
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

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";
  const tabCls = (t: string) => `px-3 py-1.5 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"}`;

  // Resolve which card the Model dropdown should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId ||
    modelCards.find((mc) => mc.model_id === form.model)?.id ||
    "";

  const [search, setSearch] = useState("");

  const displayed = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  return (
    <ListPage<Agent>
      title="Agents"
      subtitle="Create and manage autonomous agents."
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Go to agent ID..."
      searchValue={search}
      onSearchChange={setSearch}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      data={displayed}
      loading={loading}
      getRowKey={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      hasMore={hasMore}
      onLoadMore={loadMore}
      loadingMore={isLoadingMore}
      emptyTitle={search ? "No matching agents" : "No agents yet"}
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>Create your first agent to get started.</p>
            <button onClick={() => nav("/")} className="mt-3 text-sm text-brand hover:underline">
              Get started with the quickstart guide →
            </button>
          </>
        )
      }
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[180px]",
          render: (a) => <span title={a.id}>{a.id}</span>,
        },
        { key: "name", label: "Name", className: "font-medium text-fg" },
        {
          key: "model",
          label: "Model",
          className: "text-fg-muted",
          render: (a) => modelStr(a.model),
        },
        {
          key: "status",
          label: "Status",
          render: (a) => (
            <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${a.archived_at ? "bg-bg-surface text-fg-subtle" : "bg-success-subtle text-success"}`}>
              {a.archived_at ? "archived" : "active"}
            </span>
          ),
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (a) => new Date(a.created_at).toLocaleDateString(),
        },
      ]}
    >
      {/* Create dialog — kept hand-rolled (template→form/yaml/json multi-step UI not a fit for the standard Modal).
          Focus trap, scroll lock, focus restore + Escape come from the useEffect block above. */}
      {showCreate && (
        <div className="fixed inset-0 bg-bg-overlay flex items-center justify-center z-50" onClick={closeCreate}>
          <div
            ref={createDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="New Agent"
            className="bg-bg rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >

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
                    aria-label="Search templates"
                  />
                </div>
                <div className="flex-1 overflow-y-auto px-6 py-4">
                  <div className="grid grid-cols-2 gap-3">
                    {filteredTemplates.map((tmpl) => (
                      <button
                        key={tmpl.id}
                        onClick={() => selectTemplate(tmpl)}
                        className="text-left border border-border rounded-lg p-4 hover:border-brand hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
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
                <button onClick={() => { setCreateStep("template"); setTemplateSearch(""); setCreateMode("form"); }} className="text-sm text-fg-subtle hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">&larr; Templates</button>
                <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
                  {(["form", "yaml", "json"] as const).map((m) => (
                    <button key={m} onClick={() => switchMode(m)}
                      className={`px-2 py-1 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${createMode === m ? "bg-bg text-fg font-medium shadow-sm" : "text-fg-muted hover:text-fg"}`}>
                      {m === "form" ? "Form" : m.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
              {createMode === "form" && (
              <div role="tablist" aria-label="Agent configuration sections" className="flex gap-1 mt-3">
                <button role="tab" aria-selected={tab === "basic"} tabIndex={tab === "basic" ? 0 : -1} onClick={() => setTab("basic")} className={tabCls("basic")}>Basic</button>
                <button role="tab" aria-selected={tab === "tools"} tabIndex={tab === "tools" ? 0 : -1} onClick={() => setTab("tools")} className={tabCls("tools")}>
                  Tools {Object.keys(form.toolOverrides).length > 0 && (
                    <span className="ml-1 text-xs opacity-60">({Object.keys(form.toolOverrides).length})</span>
                  )}
                </button>
                <button role="tab" aria-selected={tab === "skills"} tabIndex={tab === "skills" ? 0 : -1} onClick={() => setTab("skills")} className={tabCls("skills")}>
                  Skills {form.skills.length > 0 && <span className="ml-1 text-xs opacity-60">({form.skills.length})</span>}
                </button>
                <button role="tab" aria-selected={tab === "mcp"} tabIndex={tab === "mcp" ? 0 : -1} onClick={() => setTab("mcp")} className={tabCls("mcp")}>
                  MCP Servers {form.mcpServers.length > 0 && <span className="ml-1 text-xs opacity-60">({form.mcpServers.length})</span>}
                </button>
                <button role="tab" aria-selected={tab === "agents"} tabIndex={tab === "agents" ? 0 : -1} onClick={() => setTab("agents")} className={tabCls("agents")}>
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
                    <label htmlFor="agent-name" className="text-sm text-fg-muted block mb-1">Name *</label>
                    <input id="agent-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Coding Assistant" />
                  </div>
                  {/* Model picker. (tenant_id, model_id) is UNIQUE in DB, so
                      one card == one model_id == one credentials set; the
                      old dual Model + Model Card dropdowns were redundant.
                      Local-runtime agents (form.runtimeId set) skip this
                      block — the ACP child brings its own LLM credentials.
                      Default card is pre-selected via the useEffect above. */}
                  {!form.runtimeId && (
                    modelCards.length === 0 ? (
                      <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                        No model cards configured. Cloud agents need at least one card to provide LLM credentials.{" "}
                        <a href="/model-cards" className="underline hover:text-fg-muted">Add one</a>.
                      </p>
                    ) : (
                      <div>
                        <label className="text-sm text-fg-muted block mb-1">Model</label>
                        <Combobox<ModelCard>
                          value={selectedCardId}
                          onValueChange={(v, item) => {
                            setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
                          }}
                          endpoint="/v1/model_cards"
                          getValue={(mc) => mc.id}
                          getLabel={(mc) => (
                            <span>
                              {mc.is_default ? "★ " : ""}{mc.model_id}
                              {mc.model !== mc.model_id && (
                                <span className="text-fg-subtle text-[12px]"> ({mc.model})</span>
                              )}
                            </span>
                          )}
                          getTextLabel={(mc) =>
                            `${mc.is_default ? "★ " : ""}${mc.model_id}${
                              mc.model !== mc.model_id ? ` (${mc.model})` : ""
                            }`
                          }
                          placeholder={
                            !selectedCardId && form.model
                              ? `⚠ ${form.model} — no matching card, pick one`
                              : "Select a model card..."
                          }
                        />
                      </div>
                    )
                  )}
                  {form.runtimeId && (
                    <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                      Model is determined by the ACP child on the runtime ({form.acpAgentId || "—"}) — it uses its own LLM credentials.
                    </p>
                  )}
                  <div>
                    <label htmlFor="agent-description" className="text-sm text-fg-muted block mb-1">Description</label>
                    <input id="agent-description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="A coding assistant that writes clean code..." />
                  </div>
                  <div>
                    <label htmlFor="agent-system" className="text-sm text-fg-muted block mb-1">System Prompt</label>
                    <textarea id="agent-system" value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} rows={5} className={`${inputCls} resize-none font-mono text-xs leading-relaxed`} placeholder="You are a helpful assistant..." />
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
                        <Select
                          value={form.runtimeId || "__cloud__"}
                          onValueChange={(v) => {
                            const rid = v === "__cloud__" ? "" : v;
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
                          placeholder="— Cloud (run on OMA) —"
                        >
                          <SelectOption value="__cloud__">— Cloud (run on OMA) —</SelectOption>
                          {runtimes.map((r) => (
                            <SelectOption key={r.id} value={r.id} disabled={r.status !== "online"}>
                              {r.hostname} ({r.status}{r.status === "online" && r.agents.length ? ` · ${r.agents.length} agents` : ""})
                            </SelectOption>
                          ))}
                        </Select>
                        {form.runtimeId && (
                          <div className="mt-2">
                            <label className="text-xs text-fg-subtle block mb-1">ACP agent on this machine</label>
                            {(() => {
                              const detectedAgents = runtimes.find((r) => r.id === form.runtimeId)?.agents ?? [];
                              const detectedIds = new Set(detectedAgents.map((a) => a.id));
                              // OMA promotes 4 agents as "first class" in
                              // the UI: claude-acp, codex-acp, openclaw,
                              // hermes (see overlay's `featured` flag).
                              // Featured-detected render on top so the
                              // common case is one click. Anything not
                              // detected by the daemon is intentionally
                              // hidden — users must install via cli first.
                              const featuredIds = new Set(
                                KNOWN_ACP_AGENTS.filter((e) => e.featured).map((e) => e.id),
                              );
                              const featuredDetected = detectedAgents.filter((a) => featuredIds.has(a.id));
                              const otherDetected = detectedAgents.filter((a) => !featuredIds.has(a.id));
                              return (
                                <>
                                  <Select
                                    value={form.acpAgentId}
                                    onValueChange={(v) => setForm({ ...form, acpAgentId: v, localSkillBlocklist: [] })}
                                  >
                                    {featuredDetected.length > 0 && (
                                      <SelectGroup>
                                        <SelectGroupLabel>★ Featured</SelectGroupLabel>
                                        {featuredDetected.map((a) => (
                                          <SelectOption key={a.id} value={a.id}>{a.id}</SelectOption>
                                        ))}
                                      </SelectGroup>
                                    )}
                                    {otherDetected.length > 0 && (
                                      <SelectGroup>
                                        <SelectGroupLabel>Other detected on this runtime</SelectGroupLabel>
                                        {otherDetected.map((a) => (
                                          <SelectOption key={a.id} value={a.id}>{a.id}</SelectOption>
                                        ))}
                                      </SelectGroup>
                                    )}
                                  </Select>
                                </>
                              );
                            })()}
                            <p className="text-xs text-fg-subtle mt-1">
                              Each turn spawns this ACP child on the runtime. Model + skills come from the daemon-fetched bundle.
                            </p>
                            {/* Local-skill blocklist — multi-select fed by what the
                                daemon reported in hello.local_skills[acpAgentId].
                                Default = all visible (empty blocklist). User unchecks
                                to hide a global skill from this agent. */}
                            {(() => {
                              // Canonicalize first: form.acpAgentId may be a
                              // legacy alias on stale rows ("claude-code-acp"),
                              // but the daemon emits local_skills under the
                              // canonical key ("claude-agent-acp"). Without
                              // resolving here the blocklist would silently
                              // show empty even though skills exist.
                              const canonicalId = resolveKnownAgent(form.acpAgentId)?.id ?? form.acpAgentId;
                              const localSkills =
                                runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[canonicalId] ?? [];
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

              {/* Tools tab */}
              {createMode === "form" && tab === "tools" && (
                <div className="space-y-5">
                  {createError && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{createError}</div>}

                  <p className="text-xs text-fg-subtle leading-relaxed">
                    Built-in toolset (AMA <span className="font-mono">agent_toolset_20260401</span>).
                    Multi-agent delegation lives in its own tab and is a separate
                    AMA field <span className="font-mono">multiagent</span> — not part of this toolset.
                    External MCP tools live in the MCP Servers tab.
                  </p>

                  <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
                    <div className="text-sm font-medium text-fg mb-1">Default policy</div>
                    <p className="text-xs text-fg-subtle mb-3">
                      Applies to every tool below that's set to <span className="font-mono">default</span>.
                    </p>
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={form.toolDefaultEnabled}
                          onChange={(e) => setForm({ ...form, toolDefaultEnabled: e.target.checked })}
                          className="accent-brand"
                        />
                        Enable tools
                      </label>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-fg-muted">Permission:</span>
                        <select
                          value={form.toolDefaultPermission}
                          disabled={!form.toolDefaultEnabled}
                          onChange={(e) => setForm({ ...form, toolDefaultPermission: e.target.value as "always_allow" | "always_ask" })}
                          className="border border-border rounded-md px-2 py-1 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-40"
                        >
                          <option value="always_allow">always_allow</option>
                          <option value="always_ask">always_ask</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-fg block mb-2">Per-tool overrides</label>
                    <p className="text-xs text-fg-subtle mb-3">
                      Each row's effective state is shown in the dropdown.
                      Pick <span className="font-mono">default</span> to inherit the policy above;
                      pick a specific value to override.
                      <span className="font-mono">always_ask</span> emits a{" "}
                      <span className="font-mono">user.tool_confirmation</span> event the client must
                      approve before each call.
                    </p>
                    <div className="border border-border rounded-md divide-y divide-border">
                      {BUILTIN_TOOLS.map((bt) => {
                        const current = form.toolOverrides[bt.name] ?? "default";
                        // Effective state when "default" is selected, so the
                        // user always knows what the row resolves to. Mirrors
                        // the runtime's getEnabledTools + getToolPermission.
                        const effectiveLabel = !form.toolDefaultEnabled
                          ? "disabled"
                          : form.toolDefaultPermission;
                        // Color the row when it's "off" so the disabled
                        // outcome is visually obvious.
                        const isOff =
                          current === "disabled" ||
                          (current === "default" && !form.toolDefaultEnabled);
                        return (
                          <div
                            key={bt.name}
                            className={`flex items-center justify-between px-3 py-2 gap-3 ${
                              isOff ? "opacity-50" : ""
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-mono text-fg">{bt.label}</div>
                              <div className="text-xs text-fg-subtle truncate">{bt.description}</div>
                            </div>
                            <select
                              value={current}
                              onChange={(e) => {
                                const v = e.target.value as ToolOverride;
                                const next = { ...form.toolOverrides };
                                if (v === "default") delete next[bt.name];
                                else next[bt.name] = v;
                                setForm({ ...form, toolOverrides: next });
                              }}
                              className="border border-border rounded-md px-2 py-1 text-xs bg-bg text-fg outline-none focus:border-brand shrink-0"
                            >
                              <option value="default">default ({effectiveLabel})</option>
                              <option value="always_allow">always_allow</option>
                              <option value="always_ask">always_ask</option>
                              <option value="disabled">disabled</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
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
                            className={`flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${active ? "border-brand bg-brand text-brand-fg" : "border-border hover:border-border-strong"}`}>
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
                    {(() => {
                      // Hide skills that are already surfaced under
                      // Anthropic Skills above (xlsx/pdf/pptx/docx —
                      // their backend rows show up in the same list as
                      // user-registered skills, otherwise we duplicate).
                      const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
                      const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));
                      return filtered.length > 0 ? (
                      <div className="space-y-2">
                        {filtered.map((cs) => {
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
                              className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${active ? "border-brand bg-brand text-brand-fg" : "border-border hover:border-border-strong"}`}>
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
                    );
                    })()}
                  </div>
                </div>
              )}

              {/* MCP tab */}
              {createMode === "form" && tab === "mcp" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-fg">MCP Servers</label>
                    <div className="flex items-center gap-3">
                      <button onClick={() => setShowMcpPicker(true)} className="text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">+ Pick known</button>
                      <button onClick={addMcp} className="text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">+ Custom URL</button>
                    </div>
                  </div>
                  {form.mcpServers.map((mcp, i) => (
                    <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label htmlFor={`mcp-name-${i}`} className="text-xs text-fg-muted block mb-0.5">Name</label>
                          <input id={`mcp-name-${i}`} value={mcp.name} onChange={(e) => updateMcp(i, "name", e.target.value)} className={inputCls} placeholder="github" />
                        </div>
                        <div className="w-24">
                          <label className="text-xs text-fg-muted block mb-0.5">Type</label>
                          <Select value={mcp.type} onValueChange={(v) => updateMcp(i, "type", v)}>
                            <SelectOption value="sse">sse</SelectOption>
                            <SelectOption value="stdio">stdio</SelectOption>
                          </Select>
                        </div>
                        <button onClick={() => removeMcp(i)} aria-label={`Remove MCP server ${mcp.name || i + 1}`} className="self-end px-2 py-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">×</button>
                      </div>
                      <div>
                        <label htmlFor={`mcp-url-${i}`} className="text-xs text-fg-muted block mb-0.5">URL</label>
                        <input id={`mcp-url-${i}`} value={mcp.url} onChange={(e) => updateMcp(i, "url", e.target.value)} className={inputCls} placeholder="https://mcp.github.com/sse" />
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
                <div className="space-y-5">
                  {/* Built-in general sub-agent — opt-in. Doesn't require
                      managing a dedicated callable_agents entry; spawns a
                      generic delegate that inherits this agent's model +
                      sandbox. Useful for one-off task delegation. */}
                  <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.enableGeneralSubagent}
                        onChange={(e) => setForm({ ...form, enableGeneralSubagent: e.target.checked })}
                        className="accent-brand mt-0.5"
                      />
                      <div>
                        <div className="font-medium text-fg">Enable general sub-agent</div>
                        <p className="text-xs text-fg-subtle mt-0.5">
                          Exposes a built-in <span className="font-mono">general_subagent(task)</span> tool.
                          Spawns a generic sub-agent thread (reserved id <span className="font-mono">general</span>)
                          inheriting this agent's model + sandbox, with a safe built-in tool subset
                          (bash/read/write/edit/grep/glob). No roster setup needed.
                        </p>
                      </div>
                    </label>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-fg block">Callable Agents</label>
                    <p className="text-xs text-fg-subtle mb-2">Specific agents this agent can delegate to via <span className="font-mono">call_agent_&lt;id&gt;</span> tools.</p>
                  </div>

                  {form.callableAgents.map((ca, i) => {
                    const agentInfo = allAgents.find(a => a.id === ca.id);
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg">
                        <div className="flex-1">
                          <div className="text-sm font-medium text-fg">{agentInfo?.name || ca.id}</div>
                          <div className="text-xs text-fg-subtle font-mono">{ca.id}</div>
                        </div>
                        <button onClick={() => removeCallable(i)} className="px-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">×</button>
                      </div>
                    );
                  })}

                  <div>
                    <label className="text-xs text-fg-muted block mb-1">Add agent</label>
                    <Combobox<Agent>
                      value=""
                      onValueChange={(v) => { if (v) addCallable(v); }}
                      endpoint="/v1/agents"
                      getValue={(a) => a.id}
                      getLabel={(a) => (
                        <span>
                          {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
                        </span>
                      )}
                      getTextLabel={(a) => `${a.name} (${a.id})`}
                      placeholder="Select an agent..."
                      excludeIds={form.callableAgents.map((c) => c.id)}
                    />
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
                  <button onClick={create} disabled={!form.name} className="px-5 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">Create Agent</button>
                ) : (
                  <button onClick={createFromCode} disabled={!codeValue.trim()} className="px-5 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">Create Agent</button>
                )}
              </div>
            </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* MCP server registry picker — same MCP_REGISTRY the vault page uses */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </ListPage>
  );
}
