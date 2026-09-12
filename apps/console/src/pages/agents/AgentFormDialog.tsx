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

import { useManagedApi } from "../../lib/useManagedApi";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "../../components/Select";
import { Combobox } from "../../components/Combobox";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { AGENT_TEMPLATES, type AgentTemplate } from "../../data/templates";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../../types/agent";
import { useI18n } from "../../i18n";
import {
  INITIAL_FORM,
  agentToForm,
  agentToPreservedConfig,
  configToForm,
  mergeFormIntoConfig,
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
}: AgentFormDialogProps) {
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

  const addMcp = () =>
    setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
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
        mcpServers: tmpl.mcpServers.map((m) => ({ ...m })),
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
  selectedCardId: string;
}

function BasicTab({
  form,
  setForm,
  createError,
  inputCls,
  modelCards,
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
      {modelCards.length === 0 ? (
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
          </div>
        )}
      <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-3">
        <div>
          <Label className="text-sm text-fg-muted block mb-1">
            Auxiliary model
          </Label>
          <Combobox<ModelCard>
            value={
              modelCards.find((card) => card.model_id === form.auxiliaryModel)?.id ?? ""
            }
            onValueChange={(value, item) =>
              setForm({
                ...form,
                auxiliaryModel: item?.model_id ?? (value ? form.auxiliaryModel : ""),
              })
            }
            endpoint="/v1/oma/model_cards"
            searchParam="q"
            pagination="oma"
            getValue={(card) => card.id}
            getLabel={(card) => card.model_id}
            getTextLabel={(card) => card.model_id}
            placeholder="None"
          />
        </div>
        <div>
          <Label className="text-sm text-fg-muted block mb-1">Speed</Label>
          <Select
            value={form.auxiliaryModelSpeed || "default"}
            disabled={!form.auxiliaryModel}
            onValueChange={(value) =>
              setForm({
                ...form,
                auxiliaryModelSpeed:
                  value === "standard" || value === "fast" ? value : "",
              })
            }
            className={inputCls}
          >
            <SelectOption value="default">default</SelectOption>
            <SelectOption value="standard">standard</SelectOption>
            <SelectOption value="fast">fast</SelectOption>
          </Select>
        </div>
      </div>
      <div>
        <Label
          htmlFor="agent-appendable-prompts"
          className="text-sm text-fg-muted block mb-1"
        >
          Appendable prompt IDs
        </Label>
        <Textarea
          id="agent-appendable-prompts"
          value={form.appendablePrompts.join("\n")}
          onChange={(event) =>
            setForm({
              ...form,
              appendablePrompts: event.target.value
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
          rows={3}
          className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
          placeholder="prompt_review\nprompt_security"
        />
        <p className="mt-1 text-xs text-fg-subtle">One prompt ID per line.</p>
      </div>
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
  updateMcp: (i: number, field: keyof McpEntry, val: string) => void;
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
              <div className={`${inputCls} flex items-center text-fg-muted`}>URL</div>
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
