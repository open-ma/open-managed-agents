import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import yaml from "js-yaml";
import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { useApi } from "../../lib/api";
import { useManagedApi } from "../../lib/useManagedApi";
import { Button } from "@/components/ui/button";
import { Select, SelectGroup, SelectGroupLabel, SelectOption } from "../../components/Select";
import { Combobox } from "../../components/Combobox";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { AGENT_TEMPLATES, type AgentTemplate } from "../../data/templates";
import type { ModelCard } from "@open-managed-agents/api-types";
import {
  KNOWN_ACP_AGENTS,
  resolveKnownAgent,
} from "@open-managed-agents/acp-runtime/known-agents";
import type { AgentRecord as Agent } from "../../types/agent";
import { useI18n } from "../../i18n";
import {
  INITIAL_FORM,
  agentToForm,
  agentToPreservedConfig,
  configToForm,
  mergeFormIntoConfig,
  requiresOmaAgentEndpoint,
  type FormState,
  type McpEntry,
  type SkillEntry,
  type ToolOverride,
} from "./agentFormCodec";

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

interface AgentFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after the agent is created successfully. Parent uses this
   *  to refresh the list. The dialog handles its own navigation to the
   *  new agent's detail page. */
  onCreated?: () => void;
  /** Called after a successful update in edit mode. Parent refreshes
   *  detail/list caches; the dialog closes itself and stays on the
   *  current route. */
  onUpdated?: (agent: Agent) => void;
  /** When set, the dialog opens in edit mode: skips the template step,
   *  prefills from this agent, and POSTs `/v1/agents/:id` on save. */
  agent?: Agent | null;
  /** Data sets the form's pickers pull from. The parent fetches these
   *  on mount (loadAux) and passes them down so the dialog doesn't have
   *  to re-fetch on every open. */
  allAgents: Agent[];
  customSkills: Array<{ id: string; name: string; description: string }>;
  modelCards: ModelCard[];
  runtimes: Array<{
    id: string;
    hostname: string;
    status: string;
    agents: Array<{ id: string }>;
    local_skills?: Record<
      string,
      Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>
    >;
  }>;
}

/**
 * Create / edit agent dialog. Multi-step on create (template → form) with
 * three editor modes (form / yaml / json). Edit mode skips the template
 * step and prefills from `agent`. Owns all of its own state so the parent
 * just mounts it and forwards data lists + save hooks.
 *
 * Stays hand-rolled rather than wrapping `Modal` because the
 * template→form/yaml/json multi-step header doesn't fit the standard
 * Modal layout. Focus trap, scroll lock, focus restore, and Escape
 * handling are reimplemented inline (mirroring `components/Modal.tsx`
 * behavior) so keyboard + screen-reader users get the same affordances.
 */
export function AgentFormDialog({
  open,
  onClose,
  onCreated,
  onUpdated,
  agent: editingAgent,
  allAgents,
  customSkills,
  modelCards,
  runtimes,
}: AgentFormDialogProps) {
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const isEdit = !!editingAgent;

  const [createError, setCreateError] = useState("");
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  /** Full config baseline for lossless Form↔code merges on edit. */
  const [preservedConfig, setPreservedConfig] = useState<Record<string, unknown> | null>(
    null,
  );
  const [tab, setTab] = useState<"basic" | "tools" | "skills" | "mcp" | "agents">("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
  const [showMcpPicker, setShowMcpPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const createDialogRef = useRef<HTMLDivElement>(null);
  const createPreviousFocus = useRef<HTMLElement | null>(null);

  // Prefill when opening in edit mode (or when the agent version changes
  // after a concurrent refresh). Create mode starts at the template step.
  useEffect(() => {
    if (!open) return;
    if (editingAgent) {
      setForm(agentToForm(editingAgent));
      setPreservedConfig(agentToPreservedConfig(editingAgent));
      setCreateStep("form");
      setTab("basic");
      setCreateMode("form");
      setCreateError("");
      setCodeValue("");
      setSaving(false);
    } else {
      setPreservedConfig(null);
    }
  }, [open, editingAgent?.id, editingAgent?.version]);

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

  const closeCreate = () => {
    setCreateStep("template");
    setTemplateSearch("");
    setForm({ ...INITIAL_FORM });
    setPreservedConfig(null);
    setTab("basic");
    setCreateError("");
    setCreateMode("form");
    setCodeValue("");
    setSaving(false);
    onClose();
  };

  // Dialog a11y — focus trap + Escape, scroll lock, focus restore on close.
  // Mirrors components/Modal.tsx behavior so this hand-rolled multi-step
  // dialog is keyboard-equivalent.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeCreate();
        return;
      }
      if (e.key !== "Tab") return;
      const el = createDialogRef.current;
      if (!el) return;
      const f = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // closeCreate is stable enough — deps kept tight to avoid re-binding
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const persistAgent = async (payload: Record<string, unknown>): Promise<Agent> => {
    if (requiresOmaAgentEndpoint(payload)) {
      const path = isEdit && editingAgent
        ? `/v1/oma/agents/${editingAgent.id}`
        : "/v1/oma/agents";
      return api<Agent>(path, {
        method: "POST",
        body: JSON.stringify(
          isEdit && editingAgent
            ? { ...payload, version: editingAgent.version }
            : payload,
        ),
      });
    }

    if (isEdit && editingAgent) {
      const updated = await managedApi.agents.update(editingAgent.id, {
        ...payload,
        version: editingAgent.version,
      } as AgentUpdateParams);
      return updated as unknown as Agent;
    }

    const created = await managedApi.agents.create(
      payload as unknown as AgentCreateParams,
    );
    return created as unknown as Agent;
  };

  const create = async () => {
    setCreateError("");
    setSaving(true);
    try {
      const metadata = JSON.parse(form.metadataJson);
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("Metadata must be a JSON object");
      }
      const payload = mergeFormIntoConfig(form, preservedConfig, { forUpdate: isEdit });
      if (isEdit && editingAgent) {
        const updated = await persistAgent(payload);
        closeCreate();
        onUpdated?.(updated);
      } else {
        const agent = await persistAgent(payload);
        closeCreate();
        onCreated?.();
        nav(`/agents/${agent.id}`);
      }
    } catch (e: any) {
      setCreateError(
        e?.message || (isEdit ? "Failed to update agent" : "Failed to create agent"),
      );
    } finally {
      setSaving(false);
    }
  };

  const newMcpEntry = (name = "", type = "url", url = ""): McpEntry => ({
    name,
    type,
    url,
    stdioCommand: "",
    stdioArgs: [],
    stdioEnv: {},
    stdioPort: "",
    stdioSsePath: "",
    stdioReadyTimeoutMs: "",
  });
  const addMcp = () =>
    setForm({ ...form, mcpServers: [...form.mcpServers, newMcpEntry()] });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, newMcpEntry(entry.id, "url", entry.url)],
    });
  };
  const updateMcp = <K extends keyof McpEntry>(i: number, field: K, val: McpEntry[K]) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

  const toggleAnthropicSkill = (skillId: string) => {
    const exists = form.skills.find((s) => s.type === "anthropic" && s.skill_id === skillId);
    if (exists) {
      setForm({
        ...form,
        skills: form.skills.filter((s) => !(s.type === "anthropic" && s.skill_id === skillId)),
      });
    } else {
      setForm({
        ...form,
        skills: [...form.skills, { type: "anthropic", skill_id: skillId }],
      });
    }
  };

  const addCallable = (agentId: string) => {
    if (form.callableAgents.find((c) => c.id === agentId)) return;
    setForm({
      ...form,
      callableAgents: [...form.callableAgents, { type: "agent", id: agentId, version: 1 }],
    });
  };
  const removeCallable = (i: number) =>
    setForm({ ...form, callableAgents: form.callableAgents.filter((_, j) => j !== i) });

  const selectTemplate = (tmpl: AgentTemplate) => {
    if (tmpl.id === "blank") {
      setForm({ ...INITIAL_FORM });
      setPreservedConfig(null);
    } else {
      setForm({
        ...INITIAL_FORM,
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        mcpServers: tmpl.mcpServers.map((m) => newMcpEntry(m.name, m.type, m.url)),
        skills: tmpl.skills.map((s) => ({ ...s } as SkillEntry)),
      });
      setPreservedConfig(null);
    }
    setCreateStep("form");
    setTab("basic");
  };

  // Convert current form state to a config object (lossless vs preservedConfig).
  const formToConfig = () =>
    mergeFormIntoConfig(form, preservedConfig, { forUpdate: isEdit });

  // Switch between form/yaml/json modes
  const switchMode = (mode: "form" | "yaml" | "json") => {
    if (mode === createMode) return;
    if (createMode === "form") {
      // form → code: serialize merged form + preserved unsupported fields
      const config = formToConfig();
      setPreservedConfig(config);
      setCodeValue(
        mode === "yaml" ? yaml.dump(config, { lineWidth: -1 }) : JSON.stringify(config, null, 2),
      );
    } else if (mode === "form") {
      // code → form: parse into preserved baseline, then extract form fields
      try {
        const parsed =
          createMode === "yaml"
            ? (yaml.load(codeValue) as Record<string, unknown>)
            : (JSON.parse(codeValue) as Record<string, unknown>);
        setPreservedConfig(parsed);
        setForm(configToForm(parsed));
      } catch {
        /* keep current form if parse fails */
      }
    } else {
      // yaml ↔ json: convert between formats
      try {
        const parsed = createMode === "yaml" ? yaml.load(codeValue) : JSON.parse(codeValue);
        if (parsed && typeof parsed === "object") {
          setPreservedConfig(parsed as Record<string, unknown>);
        }
        setCodeValue(
          mode === "yaml"
            ? yaml.dump(parsed, { lineWidth: -1 })
            : JSON.stringify(parsed, null, 2),
        );
      } catch {
        /* keep current value if parse fails */
      }
    }
    setCreateMode(mode);
  };

  // Create / update agent from code editor
  const createFromCode = async () => {
    setCreateError("");
    setSaving(true);
    try {
      const parsed =
        createMode === "yaml"
          ? (yaml.load(codeValue) as Record<string, unknown>)
          : JSON.parse(codeValue);
      if (!parsed.name) {
        setCreateError("name is required");
        setSaving(false);
        return;
      }
      if (!parsed.tools) parsed.tools = [{ type: "agent_toolset_20260401" }];
      if (isEdit && editingAgent) {
        const updated = await persistAgent(parsed);
        closeCreate();
        onUpdated?.(updated);
      } else {
        const agent = await persistAgent(parsed);
        closeCreate();
        onCreated?.();
        nav(`/agents/${agent.id}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invalid config";
      setCreateError(msg);
    } finally {
      setSaving(false);
    }
  };

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.tags.some((tag) => tag.toLowerCase().includes(templateSearch.toLowerCase())),
      )
    : AGENT_TEMPLATES;

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";
  const tabCls = (t: string) =>
    `inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
      tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
    }`;

  // Resolve which card the Model dropdown should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  if (!open) {
    // Render the MCP picker anyway? No — it only makes sense while the
    // form dialog is mounted.
    return null;
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-bg-overlay flex items-center justify-center z-50"
        onClick={closeCreate}
      >
        <div
          ref={createDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? t.agents.editAgentTitle : t.agents.newAgentTitle}
          className="bg-bg rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Template selection step — create only */}
          {createStep === "template" && !isEdit && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <h2 className="font-display text-lg font-semibold text-fg">{t.agents.newAgentTitle}</h2>
                <p className="text-sm text-fg-muted mt-1">
                  Start from a template or build from scratch.
                </p>
                <Input
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
                    <Button variant="ghost"
                      key={tmpl.id}
                      onClick={() => selectTemplate(tmpl)}
                      className="text-left border border-border rounded-lg p-4 hover:border-brand hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    >
                      <div className="font-medium text-sm text-fg">{tmpl.name}</div>
                      <div className="text-xs text-fg-muted mt-1 line-clamp-2">
                        {tmpl.description}
                      </div>
                      {tmpl.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {tmpl.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-0.5 bg-bg-surface text-fg-muted rounded text-xs"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </Button>
                  ))}
                </div>
                {filteredTemplates.length === 0 && (
                  <div className="text-center py-8 text-fg-subtle text-sm">
                    No templates match your search.
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-border flex justify-end">
                <Button variant="ghost"
                  onClick={closeCreate}
                  className="inline-flex items-center min-h-11 sm:min-h-0 px-4 py-2 text-sm text-fg-muted hover:text-fg"
                >
                  {t.common.cancel}
                </Button>
              </div>
            </>
          )}

          {/* Form step */}
          {createStep === "form" && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                  {isEdit ? (
                    <span className="text-sm text-fg-subtle">
                      {t.agents.editingVersion.replace(
                        "{version}",
                        String(editingAgent?.version ?? ""),
                      )}
                    </span>
                  ) : (
                    <Button variant="ghost"
                      onClick={() => {
                        setCreateStep("template");
                        setTemplateSearch("");
                        setCreateMode("form");
                      }}
                      className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-fg-subtle hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    >
                      &larr; Templates
                    </Button>
                  )}
                  <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
                    {(["form", "yaml", "json"] as const).map((m) => (
                      <Button variant="ghost"
                        key={m}
                        onClick={() => switchMode(m)}
                        className={`inline-flex items-center justify-center px-2 py-1 min-h-11 sm:min-h-0 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                          createMode === m
                            ? "bg-bg text-fg font-medium shadow-sm"
                            : "text-fg-muted hover:text-fg"
                        }`}
                      >
                        {m === "form" ? "Form" : m.toUpperCase()}
                      </Button>
                    ))}
                  </div>
                </div>
                <h2 className="font-display text-lg font-semibold text-fg">
                  {isEdit ? t.agents.editAgentTitle : t.agents.newAgentTitle}
                </h2>
                {createMode === "form" && (
                  <div
                    role="tablist"
                    aria-label="Agent configuration sections"
                    className="flex gap-1 mt-3"
                  >
                    <Button variant="ghost"
                      role="tab"
                      aria-selected={tab === "basic"}
                      tabIndex={tab === "basic" ? 0 : -1}
                      onClick={() => setTab("basic")}
                      className={tabCls("basic")}
                    >
                      Basic
                    </Button>
                    <Button variant="ghost"
                      role="tab"
                      aria-selected={tab === "tools"}
                      tabIndex={tab === "tools" ? 0 : -1}
                      onClick={() => setTab("tools")}
                      className={tabCls("tools")}
                    >
                      Tools{" "}
                      {Object.keys(form.toolOverrides).length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({Object.keys(form.toolOverrides).length})
                        </span>
                      )}
                    </Button>
                    <Button variant="ghost"
                      role="tab"
                      aria-selected={tab === "skills"}
                      tabIndex={tab === "skills" ? 0 : -1}
                      onClick={() => setTab("skills")}
                      className={tabCls("skills")}
                    >
                      Skills{" "}
                      {form.skills.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">({form.skills.length})</span>
                      )}
                    </Button>
                    <Button variant="ghost"
                      role="tab"
                      aria-selected={tab === "mcp"}
                      tabIndex={tab === "mcp" ? 0 : -1}
                      onClick={() => setTab("mcp")}
                      className={tabCls("mcp")}
                    >
                      MCP Servers{" "}
                      {form.mcpServers.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.mcpServers.length})
                        </span>
                      )}
                    </Button>
                    <Button variant="ghost"
                      role="tab"
                      aria-selected={tab === "agents"}
                      tabIndex={tab === "agents" ? 0 : -1}
                      onClick={() => setTab("agents")}
                      className={tabCls("agents")}
                    >
                      Multi-Agent{" "}
                      {form.callableAgents.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.callableAgents.length})
                        </span>
                      )}
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4">
                {/* Code editor mode (YAML/JSON) */}
                {createMode !== "form" && (
                  <div className="space-y-3 h-full flex flex-col">
                    {createError && (
                      <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                        {createError}
                      </div>
                    )}
                    <Textarea
                      value={codeValue}
                      onChange={(e) => setCodeValue(e.target.value)}
                      className={`${inputCls} flex-1 resize-none font-mono text-xs leading-relaxed min-h-[300px]`}
                      spellCheck={false}
                    />
                  </div>
                )}
                {/* Form mode */}
                {createMode === "form" && tab === "basic" && (
                  <BasicTab
                    form={form}
                    setForm={setForm}
                    createError={createError}
                    inputCls={inputCls}
                    modelCards={modelCards}
                    runtimes={runtimes}
                    selectedCardId={selectedCardId}
                  />
                )}

                {createMode === "form" && tab === "tools" && (
                  <ToolsTab form={form} setForm={setForm} createError={createError} />
                )}

                {createMode === "form" && tab === "skills" && (
                  <SkillsTab
                    form={form}
                    setForm={setForm}
                    customSkills={customSkills}
                    toggleAnthropicSkill={toggleAnthropicSkill}
                  />
                )}

                {createMode === "form" && tab === "mcp" && (
                  <McpTab
                    form={form}
                    inputCls={inputCls}
                    onPickFromRegistry={() => setShowMcpPicker(true)}
                    addMcp={addMcp}
                    updateMcp={updateMcp}
                    removeMcp={removeMcp}
                  />
                )}

                {createMode === "form" && tab === "agents" && (
                  <AgentsTab
                    form={form}
                    setForm={setForm}
                    allAgents={allAgents}
                    addCallable={addCallable}
                    removeCallable={removeCallable}
                  />
                )}
              </div>

              <div className="px-6 py-4 border-t border-border flex justify-between items-center">
                <div className="text-xs text-fg-subtle">
                  {createMode === "form" && (
                    <>
                      {form.skills.length > 0 && (
                        <span className="mr-3">{form.skills.length} skills</span>
                      )}
                      {form.mcpServers.length > 0 && (
                        <span className="mr-3">{form.mcpServers.length} MCP</span>
                      )}
                      {form.callableAgents.length > 0 && (
                        <span>{form.callableAgents.length} agents</span>
                      )}
                    </>
                  )}
                  {createMode !== "form" && <span>{createMode.toUpperCase()} editor</span>}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={closeCreate} disabled={saving}>
                    {t.common.cancel}
                  </Button>
                  {createMode === "form" ? (
                    <Button onClick={create} disabled={!form.name || saving}>
                      {saving
                        ? isEdit
                          ? t.common.saving
                          : t.common.creating
                        : isEdit
                          ? t.common.saveChanges
                          : t.agents.createAgent}
                    </Button>
                  ) : (
                    <Button onClick={createFromCode} disabled={!codeValue.trim() || saving}>
                      {saving
                        ? isEdit
                          ? t.common.saving
                          : t.common.creating
                        : isEdit
                          ? t.common.saveChanges
                          : t.agents.createAgent}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* MCP server registry picker — same MCP_REGISTRY the vault page uses */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </>
  );
}

type FormSetter = React.Dispatch<React.SetStateAction<FormState>>;

interface BasicTabProps {
  form: FormState;
  setForm: FormSetter;
  createError: string;
  inputCls: string;
  modelCards: ModelCard[];
  runtimes: AgentFormDialogProps["runtimes"];
  selectedCardId: string;
}

function BasicTab({
  form,
  setForm,
  createError,
  inputCls,
  modelCards,
  runtimes,
  selectedCardId,
}: BasicTabProps) {
  return (
    <div className="space-y-3">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}
      <div>
        <Label htmlFor="agent-name" className="text-sm text-fg-muted block mb-1">
          Name *
        </Label>
        <Input
          id="agent-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className={inputCls}
          placeholder="Coding Assistant"
        />
      </div>
      {/* Model picker — see comments at the original call site. */}
      {!form.runtimeId &&
        (modelCards.length === 0 ? (
          <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
            No model cards configured. Cloud agents need at least one card to provide LLM
            credentials.{" "}
            <a href="/model-cards" className="underline hover:text-fg-muted">
              Add one
            </a>
            .
          </p>
        ) : (
          <div>
            <Label className="text-sm text-fg-muted block mb-1">Model</Label>
            <Combobox<ModelCard>
              value={selectedCardId}
              onValueChange={(v, item) => {
                setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
              }}
              endpoint="/v1/oma/model_cards"
              searchParam="q"
              pagination="oma"
              getValue={(mc) => mc.id}
              getLabel={(mc) => (
                <span>
                  {mc.is_default ? "★ " : ""}
                  {mc.model_id}
                  {mc.model !== mc.model_id && (
                    <span className="text-fg-subtle text-sm"> ({mc.model})</span>
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
            <div className="mt-2 flex items-center gap-2">
              <Label className="text-xs text-fg-muted">Speed</Label>
              <Select
                value={form.modelSpeed || "__provider_default__"}
                onValueChange={(value) =>
                  setForm({
                    ...form,
                    modelSpeed:
                      value === "standard" || value === "fast" ? value : "",
                  })
                }
                className="border border-border rounded-md px-2 py-1 text-xs bg-bg text-fg"
              >
                <SelectOption value="__provider_default__">Provider default</SelectOption>
                <SelectOption value="standard">standard</SelectOption>
                <SelectOption value="fast">fast</SelectOption>
              </Select>
              <span className="text-xs text-fg-subtle">Other model options are retained unchanged.</span>
            </div>
          </div>
        ))}
      {form.runtimeId && (
        <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
          Model is determined by the ACP child on the runtime ({form.acpAgentId || "—"}) — it
          uses its own LLM credentials.
        </p>
      )}
      <div>
        <Label htmlFor="agent-description" className="text-sm text-fg-muted block mb-1">
          Description
        </Label>
        <Input
          id="agent-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={inputCls}
          placeholder="A coding assistant that writes clean code..."
        />
      </div>
      <div>
        <Label htmlFor="agent-system" className="text-sm text-fg-muted block mb-1">
          System Prompt
        </Label>
        <Textarea
          id="agent-system"
          value={form.system}
          onChange={(e) => setForm({ ...form, system: e.target.value })}
          rows={5}
          className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
          placeholder="You are a helpful assistant..."
        />
      </div>
      <div className="border border-border rounded-lg p-3 space-y-3">
        <div>
          <Label htmlFor="agent-aux-model" className="text-sm text-fg-muted block mb-1">
            Auxiliary model <span className="text-xs text-fg-subtle">(optional)</span>
          </Label>
          <Input
            id="agent-aux-model"
            value={form.auxiliaryModel}
            onChange={(e) => setForm({ ...form, auxiliaryModel: e.target.value })}
            className={inputCls}
            placeholder="claude-haiku-4-5"
          />
          <div className="mt-2 flex items-center gap-2">
            <Label className="text-xs text-fg-muted">Speed</Label>
            <Select
              value={form.auxiliaryModelSpeed || "__provider_default__"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  auxiliaryModelSpeed:
                    value === "standard" || value === "fast" ? value : "",
                })
              }
              className="border border-border rounded-md px-2 py-1 text-xs bg-bg text-fg"
            >
              <SelectOption value="__provider_default__">Provider default</SelectOption>
              <SelectOption value="standard">standard</SelectOption>
              <SelectOption value="fast">fast</SelectOption>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="agent-appendable-prompts" className="text-sm text-fg-muted block mb-1">
            Appendable prompt IDs
          </Label>
          <Textarea
            id="agent-appendable-prompts"
            value={form.appendablePrompts.join("\n")}
            onChange={(e) =>
              setForm({
                ...form,
                appendablePrompts: e.target.value.split("\n").map((value) => value.trim()).filter(Boolean),
              })
            }
            className={`${inputCls} min-h-16 font-mono text-xs`}
            placeholder="prompt_security_review"
          />
        </div>
        <div>
          <Label htmlFor="agent-metadata" className="text-sm text-fg-muted block mb-1">
            Metadata (JSON)
          </Label>
          <Textarea
            id="agent-metadata"
            value={form.metadataJson}
            onChange={(e) => setForm({ ...form, metadataJson: e.target.value })}
            className={`${inputCls} min-h-20 font-mono text-xs`}
            spellCheck={false}
          />
        </div>
      </div>
      {/* Local Runtime — bind agent's loop to a user-registered machine
          instead of OMA's cloud SessionDO. The "no runtime" option is the
          default cloud agent. */}
      <div>
        <Label className="text-sm text-fg-muted block mb-1">
          Local Runtime
          <span className="ml-1 text-xs text-fg-subtle">(optional)</span>
        </Label>
        {runtimes.length === 0 ? (
          <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
            No runtimes registered.{" "}
            <a href="/runtimes" className="underline hover:text-fg-muted">
              Connect a machine
            </a>{" "}
            to delegate this agent's loop to your own Claude Code (or other ACP) child.
          </p>
        ) : (
          <>
            <Select
              value={form.runtimeId || "__cloud__"}
              onValueChange={(v) => {
                const rid = v === "__cloud__" ? "" : v;
                // Auto-pick the first detected ACP agent on the chosen runtime —
                // user doesn't have to know what strings the daemon emits.
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
                  {r.hostname} ({r.status}
                  {r.status === "online" && r.agents?.length
                    ? ` · ${r.agents.length} agents`
                    : ""}
                  )
                </SelectOption>
              ))}
            </Select>
            {form.runtimeId && (
              <AcpAgentPicker form={form} setForm={setForm} runtimes={runtimes} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AcpAgentPicker({
  form,
  setForm,
  runtimes,
}: {
  form: FormState;
  setForm: FormSetter;
  runtimes: AgentFormDialogProps["runtimes"];
}) {
  const detectedAgents = runtimes.find((r) => r.id === form.runtimeId)?.agents ?? [];
  // OMA promotes 4 agents as "first class" in the UI (overlay's
  // `featured` flag). Featured-detected render on top so the common
  // case is one click. Anything not detected by the daemon is
  // intentionally hidden — users must install via cli first.
  const featuredIds = new Set(KNOWN_ACP_AGENTS.filter((e) => e.featured).map((e) => e.id));
  const featuredDetected = detectedAgents.filter((a) => featuredIds.has(a.id));
  const otherDetected = detectedAgents.filter((a) => !featuredIds.has(a.id));

  // Canonicalize first: form.acpAgentId may be a legacy alias on stale
  // rows ("claude-code-acp"), but the daemon emits local_skills under the
  // canonical key ("claude-agent-acp"). Without resolving here the
  // blocklist would silently show empty even though skills exist.
  const canonicalId = resolveKnownAgent(form.acpAgentId)?.id ?? form.acpAgentId;
  const localSkills =
    runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[canonicalId] ?? [];

  return (
    <div className="mt-2">
      <Label className="text-xs text-fg-subtle block mb-1">ACP agent on this machine</Label>
      <Select
        value={form.acpAgentId}
        onValueChange={(v) =>
          setForm({ ...form, acpAgentId: v, localSkillBlocklist: [] })
        }
      >
        {featuredDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>★ Featured</SelectGroupLabel>
            {featuredDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
        {otherDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>Other detected on this runtime</SelectGroupLabel>
            {otherDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
      </Select>
      <p className="text-xs text-fg-subtle mt-1">
        Each turn spawns this ACP child on the runtime. Model + skills come from the
        daemon-fetched bundle.
      </p>

      {/* Local-skill blocklist — multi-select fed by what the daemon
          reported in hello.local_skills[acpAgentId]. */}
      {localSkills.length > 0 && (
        <LocalSkillBlocklist form={form} setForm={setForm} localSkills={localSkills} />
      )}
    </div>
  );
}

function LocalSkillBlocklist({
  form,
  setForm,
  localSkills,
}: {
  form: FormState;
  setForm: FormSetter;
  localSkills: Array<{
    id: string;
    name?: string;
    description?: string;
    source?: string;
    source_label?: string;
  }>;
}) {
  const allowed = new Set(localSkills.map((s) => s.id));
  for (const id of form.localSkillBlocklist) allowed.delete(id);
  return (
    <div className="mt-3 border border-border rounded-md p-2.5 bg-bg-surface">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-muted">
          Local skills ({allowed.size}/{localSkills.length} visible)
        </span>
        <Button variant="ghost"
          type="button"
          onClick={() => setForm({ ...form, localSkillBlocklist: [] })}
          className="inline-flex items-center min-h-11 sm:min-h-0 px-1 text-xs text-fg-subtle hover:text-fg underline"
        >
          reset
        </Button>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {localSkills.map((s) => {
          const blocked = form.localSkillBlocklist.includes(s.id);
          return (
            <Label
              key={s.id}
              className="flex items-start gap-2 text-xs cursor-pointer hover:bg-bg rounded px-1.5 py-0.5"
            >
              <Checkbox
                checked={!blocked}
                onCheckedChange={(checked) => {
                  const next = new Set(form.localSkillBlocklist);
                  if (checked === true) next.delete(s.id);
                  else next.add(s.id);
                  setForm({ ...form, localSkillBlocklist: [...next] });
                }}
                className="mt-0.5"
              />
              <span className="font-mono text-fg flex-shrink-0">{s.id}</span>
              <span className="text-fg-subtle">
                ({s.source ?? "global"}
                {s.source_label ? `:${s.source_label}` : ""})
              </span>
              {s.name && s.name !== s.id && (
                <span className="text-fg-muted truncate">— {s.name}</span>
              )}
            </Label>
          );
        })}
      </div>
      <p className="text-xs text-fg-subtle mt-1.5">
        Unchecked = hidden from the ACP child (daemon won't symlink the dir into the spawn
        cwd).
      </p>
    </div>
  );
}

function ToolsTab({
  form,
  setForm,
  createError,
}: {
  form: FormState;
  setForm: FormSetter;
  createError: string;
}) {
  return (
    <div className="space-y-5">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}

      <p className="text-xs text-fg-subtle leading-relaxed">
        Built-in toolset (AMA <span className="font-mono">agent_toolset_20260401</span>).
        Multi-agent delegation lives in its own tab and is a separate AMA field{" "}
        <span className="font-mono">multiagent</span> — not part of this toolset. External MCP
        tools live in the MCP Servers tab.
      </p>

      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <div className="text-sm font-medium text-fg mb-1">Default policy</div>
        <p className="text-xs text-fg-subtle mb-3">
          Applies to every tool below that's set to{" "}
          <span className="font-mono">default</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.toolDefaultEnabled}
              onCheckedChange={(checked) =>
                setForm({ ...form, toolDefaultEnabled: checked === true })
              }
            />
            Enable tools
          </Label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Permission:</span>
            <Select
              value={form.toolDefaultPermission}
              disabled={!form.toolDefaultEnabled}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  toolDefaultPermission: value as "always_allow" | "always_ask",
                })
              }
              className="border border-border rounded-md px-2 py-1 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-40"
            >
              <SelectOption value="always_allow">always_allow</SelectOption>
              <SelectOption value="always_ask">always_ask</SelectOption>
            </Select>
          </div>
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium text-fg block mb-2">Per-tool overrides</Label>
        <p className="text-xs text-fg-subtle mb-3">
          Each row's effective state is shown in the dropdown. Pick{" "}
          <span className="font-mono">default</span> to inherit the policy above; pick a
          specific value to override. <span className="font-mono">always_ask</span> emits a{" "}
          <span className="font-mono">user.tool_confirmation</span> event the client must
          approve before each call.
        </p>
        <div className="border border-border rounded-md divide-y divide-border">
          {BUILTIN_TOOLS.map((bt) => {
            const current = form.toolOverrides[bt.name] ?? "default";
            const effectiveLabel = !form.toolDefaultEnabled
              ? "disabled"
              : form.toolDefaultPermission;
            const isOff =
              current === "disabled" || (current === "default" && !form.toolDefaultEnabled);
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
                <Select
                  value={current}
                  onValueChange={(value) => {
                    const v = value as ToolOverride;
                    const next = { ...form.toolOverrides };
                    if (v === "default") delete next[bt.name];
                    else next[bt.name] = v;
                    setForm({ ...form, toolOverrides: next });
                  }}
                  className="border border-border rounded-md px-2 py-1 min-h-11 sm:min-h-0 text-xs bg-bg text-fg outline-none focus:border-brand shrink-0"
                >
                  <SelectOption value="default">default ({effectiveLabel})</SelectOption>
                  <SelectOption value="always_allow">always_allow</SelectOption>
                  <SelectOption value="always_ask">always_ask</SelectOption>
                  <SelectOption value="disabled">disabled</SelectOption>
                </Select>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SkillsTab({
  form,
  setForm,
  customSkills,
  toggleAnthropicSkill,
}: {
  form: FormState;
  setForm: FormSetter;
  customSkills: AgentFormDialogProps["customSkills"];
  toggleAnthropicSkill: (id: string) => void;
}) {
  // Hide skills that are already surfaced under Anthropic Skills above
  // (xlsx/pdf/pptx/docx — their backend rows show up in the same list as
  // user-registered skills, otherwise we duplicate).
  const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
  const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium text-fg block mb-2">Anthropic Skills</Label>
        <div className="grid grid-cols-2 gap-2">
          {ANTHROPIC_SKILLS.map((s) => {
            const active = form.skills.some(
              (sk) => sk.type === "anthropic" && sk.skill_id === s.id,
            );
            return (
              <Button variant="ghost"
                key={s.id}
                onClick={() => toggleAnthropicSkill(s.id)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                  active
                    ? "border-brand bg-brand text-brand-fg"
                    : "border-border hover:border-border-strong"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                    active
                      ? "bg-brand-fg text-brand border-brand-fg"
                      : "border-border-strong"
                  }`}
                >
                  {active && "✓"}
                </span>
                {s.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div>
        <Label className="text-sm font-medium text-fg block mb-2">Custom Skills</Label>
        {filtered.length > 0 ? (
          <div className="space-y-2">
            {filtered.map((cs) => {
              const active = form.skills.some(
                (sk) => sk.type === "custom" && sk.skill_id === cs.id,
              );
              return (
                <Button variant="ghost"
                  key={cs.id}
                  onClick={() => {
                    if (active) {
                      setForm({
                        ...form,
                        skills: form.skills.filter(
                          (sk) => !(sk.type === "custom" && sk.skill_id === cs.id),
                        ),
                      });
                    } else {
                      setForm({
                        ...form,
                        skills: [
                          ...form.skills,
                          { type: "custom", skill_id: cs.id, version: "latest" },
                        ],
                      });
                    }
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                    active
                      ? "border-brand bg-brand text-brand-fg"
                      : "border-border hover:border-border-strong"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center text-xs shrink-0 ${
                      active
                        ? "bg-brand-fg text-brand border-brand-fg"
                        : "border-border-strong"
                    }`}
                  >
                    {active && "✓"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{cs.name}</div>
                    <div
                      className={`text-xs truncate ${
                        active ? "text-brand-fg/70" : "text-fg-subtle"
                      }`}
                    >
                      {cs.description}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      active ? "text-brand-fg/60" : "text-fg-subtle"
                    }`}
                  >
                    {cs.id}
                  </span>
                </Button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">
            No custom skills registered.{" "}
            <a href="/skills" className="underline hover:text-fg-muted">
              Create one
            </a>
            .
          </p>
        )}
      </div>
      {form.skills.length > 0 && (
        <div className="border border-border rounded-lg p-3 space-y-2">
          <Label className="text-sm font-medium text-fg block">Pinned skill versions</Label>
          {form.skills.map((skill, index) => (
            <div key={`${skill.type}:${skill.skill_id}`} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate font-mono text-xs text-fg-muted">
                {skill.skill_id}
              </span>
              <Input
                value={skill.version ?? ""}
                onChange={(e) => {
                  const skills = [...form.skills];
                  skills[index] = { ...skill, version: e.target.value || undefined };
                  setForm({ ...form, skills });
                }}
                className="w-32 border border-border rounded px-2 py-1 text-xs bg-bg text-fg"
                placeholder="latest"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpTab({
  form,
  inputCls,
  onPickFromRegistry,
  addMcp,
  updateMcp,
  removeMcp,
}: {
  form: FormState;
  inputCls: string;
  onPickFromRegistry: () => void;
  addMcp: () => void;
  updateMcp: <K extends keyof McpEntry>(i: number, field: K, val: McpEntry[K]) => void;
  removeMcp: (i: number) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <Label className="text-sm font-medium text-fg">MCP Servers</Label>
        <div className="flex items-center gap-3">
          <Button variant="ghost"
            onClick={onPickFromRegistry}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Pick known
          </Button>
          <Button variant="ghost"
            onClick={addMcp}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Custom URL
          </Button>
        </div>
      </div>
      {form.mcpServers.map((mcp, i) => (
        <div key={i} className="border border-border rounded-lg p-3 space-y-2">
          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor={`mcp-name-${i}`} className="text-xs text-fg-muted block mb-0.5">
                Name
              </Label>
              <Input
                id={`mcp-name-${i}`}
                value={mcp.name}
                onChange={(e) => updateMcp(i, "name", e.target.value)}
                className={inputCls}
                placeholder="github"
              />
            </div>
            <div className="w-24">
              <Label className="text-xs text-fg-muted block mb-0.5">Type</Label>
              <Select value={mcp.type} onValueChange={(v) => updateMcp(i, "type", v)}>
                <SelectOption value="url">url</SelectOption>
                <SelectOption value="sse">sse</SelectOption>
                <SelectOption value="stdio">stdio</SelectOption>
              </Select>
            </div>
            <Button variant="ghost"
              onClick={() => removeMcp(i)}
              aria-label={`Remove MCP server ${mcp.name || i + 1}`}
              className="self-end inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 py-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              ×
            </Button>
          </div>
          <div>
            <Label htmlFor={`mcp-url-${i}`} className="text-xs text-fg-muted block mb-0.5">
              URL
            </Label>
            <Input
              id={`mcp-url-${i}`}
              value={mcp.url}
              onChange={(e) => updateMcp(i, "url", e.target.value)}
              className={inputCls}
              placeholder="https://mcp.github.com/sse"
            />
          </div>
          {mcp.type === "stdio" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <div>
                <Label htmlFor={`mcp-command-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Command
                </Label>
                <Input id={`mcp-command-${i}`} value={mcp.stdioCommand}
                  onChange={(e) => updateMcp(i, "stdioCommand", e.target.value)} className={inputCls}
                  placeholder="uvx" />
              </div>
              <div>
                <Label htmlFor={`mcp-port-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Port
                </Label>
                <Input id={`mcp-port-${i}`} type="number" value={mcp.stdioPort}
                  onChange={(e) => updateMcp(i, "stdioPort", e.target.value)} className={inputCls}
                  placeholder="8765" />
              </div>
              <div>
                <Label htmlFor={`mcp-sse-path-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  SSE path (optional)
                </Label>
                <Input id={`mcp-sse-path-${i}`} value={mcp.stdioSsePath}
                  onChange={(e) => updateMcp(i, "stdioSsePath", e.target.value)} className={inputCls}
                  placeholder="/sse" />
              </div>
              <div>
                <Label htmlFor={`mcp-ready-timeout-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Ready timeout (ms)
                </Label>
                <Input id={`mcp-ready-timeout-${i}`} type="number" value={mcp.stdioReadyTimeoutMs}
                  onChange={(e) => updateMcp(i, "stdioReadyTimeoutMs", e.target.value)} className={inputCls}
                  placeholder="60000" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor={`mcp-args-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Arguments (one per line)
                </Label>
                <Textarea id={`mcp-args-${i}`} value={mcp.stdioArgs.join("\n")}
                  onChange={(e) => updateMcp(i, "stdioArgs", e.target.value.split("\n").filter(Boolean))}
                  className={`${inputCls} min-h-16 font-mono text-xs`} placeholder="mcp-server-github" />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor={`mcp-env-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Environment (JSON, non-secret)
                </Label>
                <Textarea id={`mcp-env-${i}`} value={JSON.stringify(mcp.stdioEnv)}
                  onChange={(e) => {
                    try {
                      const parsed: unknown = JSON.parse(e.target.value);
                      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        const env = Object.entries(parsed).reduce<Record<string, string>>(
                          (next, [key, value]) => {
                            if (typeof value === "string") next[key] = value;
                            return next;
                          },
                          {},
                        );
                        updateMcp(i, "stdioEnv", env);
                      }
                    } catch { /* retain the last valid env while typing */ }
                  }} className={`${inputCls} min-h-16 font-mono text-xs`} placeholder='{"LOG_LEVEL":"info"}' />
                <p className="text-xs text-fg-subtle mt-1">Use Vaults for credentials; existing legacy credential fields are retained but never displayed here.</p>
              </div>
            </div>
          )}
        </div>
      ))}
      {form.mcpServers.length === 0 && (
        <div className="text-center py-8 text-fg-subtle">
          <p className="text-sm">No MCP servers configured.</p>
          <p className="text-xs mt-1">
            MCP servers provide external tools via the Model Context Protocol.
          </p>
        </div>
      )}
    </div>
  );
}

function AgentsTab({
  form,
  setForm,
  allAgents,
  addCallable,
  removeCallable,
}: {
  form: FormState;
  setForm: FormSetter;
  allAgents: Agent[];
  addCallable: (agentId: string) => void;
  removeCallable: (i: number) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Built-in general sub-agent — opt-in. */}
      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <Label className="flex items-start gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={form.enableGeneralSubagent}
            onCheckedChange={(checked) =>
              setForm({ ...form, enableGeneralSubagent: checked === true })
            }
            className="mt-0.5"
          />
          <div>
            <div className="font-medium text-fg">Enable general sub-agent</div>
            <p className="text-xs text-fg-subtle mt-0.5">
              Exposes a built-in{" "}
              <span className="font-mono">general_subagent(task)</span> tool. Spawns a
              generic sub-agent thread (reserved id{" "}
              <span className="font-mono">general</span>) inheriting this agent's model +
              sandbox, with a safe built-in tool subset
              (bash/read/write/edit/grep/glob). No roster setup needed.
            </p>
          </div>
        </Label>
      </div>

      <div>
        <Label className="text-sm font-medium text-fg block">Callable Agents</Label>
        <p className="text-xs text-fg-subtle mb-2">
          Specific agents this agent can delegate to via{" "}
          <span className="font-mono">call_agent_&lt;id&gt;</span> tools.
        </p>
      </div>

      {form.callableAgents.map((ca, i) => {
        const agentInfo = allAgents.find((a) => a.id === ca.id);
        return (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg"
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">{agentInfo?.name || ca.id}</div>
              <div className="text-xs text-fg-subtle font-mono">{ca.id}</div>
            </div>
            <div className="w-20">
              <Label className="text-xs text-fg-subtle">Version</Label>
              <Input
                type="number"
                min="1"
                value={ca.version}
                onChange={(e) => {
                  const version = Number(e.target.value);
                  if (!Number.isInteger(version) || version < 1) return;
                  const callableAgents = [...form.callableAgents];
                  callableAgents[i] = { ...ca, version };
                  setForm({ ...form, callableAgents });
                }}
                className="w-full border border-border rounded px-1 py-1 text-xs bg-bg text-fg"
              />
            </div>
            <Button variant="ghost"
              onClick={() => removeCallable(i)}
              className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              ×
            </Button>
          </div>
        );
      })}

      <div>
        <Label className="text-xs text-fg-muted block mb-1">Add agent</Label>
        <Combobox<Agent>
          value=""
          onValueChange={(v) => {
            if (v) addCallable(v);
          }}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => (
            <span>
              {a.name} <span className="text-fg-subtle text-sm">({a.id})</span>
            </span>
          )}
          getTextLabel={(a) => `${a.name} (${a.id})`}
          placeholder="Select an agent..."
          excludeIds={form.callableAgents.map((c) => c.id)}
        />
      </div>

      {form.callableAgents.length === 0 && allAgents.length === 0 && (
        <p className="text-xs text-fg-subtle">
          Create other agents first to enable multi-agent delegation.
        </p>
      )}
    </div>
  );
}
