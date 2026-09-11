import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useState, useMemo, useCallback } from "react";
import { useApi } from "../lib/api";
import { useOmaInfiniteApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { TextInput, SecretInput } from "../components/Input";
import { toast } from "sonner";
import type { ModelCard } from "@open-managed-agents/api-types";
import { useI18n } from "../i18n";
import { LocalDebugOnlyWarning } from "../components/LocalDebugOnlyWarning";

// Common Pi provider presets. The actual provider id is an open string; the
// text field below also accepts any current/future Pi id or a custom id.
const PROVIDERS = [
  { value: "anthropic", label: "Anthropic", desc: "Claude models" },
  { value: "openai", label: "OpenAI", desc: "GPT models" },
  { value: "deepseek", label: "DeepSeek", desc: "DeepSeek catalog" },
  { value: "openrouter", label: "OpenRouter", desc: "OpenRouter catalog" },
  { value: "google", label: "Google", desc: "Gemini models" },
  { value: "minimax", label: "MiniMax", desc: "MiniMax models" },
] as const;

type ProviderValue = string;

const PROVIDER_FILTER_OPTIONS: { value: ProviderValue | "any"; label: string }[] = [
  { value: "any", label: "All" },
  ...PROVIDERS.map((p) => ({ value: p.value, label: p.label })),
];

const INITIAL_FORM = {
  provider: "anthropic" as ProviderValue,
  model_id: "",
  model: "",
  api_key: "",
  base_url: "",
  is_default: false,
  pi_config: "",
  custom_headers: [{ key: "", value: "" }] as Array<{ key: string; value: string }>,
};

export function ModelCardsList() {
  const { api } = useApi();
  const { t } = useI18n();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [error, setError] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showModelSuggestions, setShowModelSuggestions] = useState(false);

  // Server-driven filter state. Each piece flows into cardsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [provider, setProvider] = useState<ProviderValue | "any">("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const cardsParams = useMemo(
    () => ({
      ...(provider !== "any" ? { provider } : {}),
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [provider, created.after, created.before, search],
  );

  const {
    items: cards,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useOmaInfiniteApiQuery<ModelCard>("/v1/oma/model_cards", { limit: 20, params: cardsParams });

  // Provider discovery is Pi catalog metadata; credentials stay in the Model
  // Card create/rotate request and are never forwarded just to browse models.
  const fetchModels = useCallback(async (provider: string) => {
    if (!provider.trim()) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    try {
      const result = await api<{ data: Array<{ id: string; name: string }> }>("/v1/oma/models/list", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      setAvailableModels(result.data);
    } catch {
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, [api]);

  const save = async () => {
    setError("");
    if (!form.model_id || (!editingId && !form.api_key)) {
      setError("Model ID and API Key are required.");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        provider: form.provider,
        model_id: form.model_id,
        // model defaults to model_id when blank — common case is "the handle
        // IS the LLM string". Users only fill `model` when they want a
        // distinct wire-level value (e.g. handle "claude-prod" → wire
        // "claude-sonnet-4-6").
        model: form.model || form.model_id,
        api_key: form.api_key,
        is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;
      // Serialize custom headers from array to object
      const hdrs: Record<string, string> = {};
      for (const h of form.custom_headers) {
        if (h.key && h.value) hdrs[h.key] = h.value;
      }
      if (Object.keys(hdrs).length > 0) payload.custom_headers = hdrs;
      if (form.pi_config.trim()) {
        let piConfig: unknown;
        try {
          piConfig = JSON.parse(form.pi_config);
        } catch {
          setError("Pi Config must be valid JSON.");
          return;
        }
        if (typeof piConfig !== "object" || piConfig === null || Array.isArray(piConfig)) {
          setError("Pi Config must be a JSON object.");
          return;
        }
        payload.pi_config = piConfig;
      }
      if (editingId) {
        if (!form.api_key) delete payload.api_key;
        await api(`/v1/oma/model_cards/${editingId}`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        // Create returns the card + a probe result. Surface it so the user
        // finds out NOW if their api_key / base_url / model id is broken.
        const created = await api<{ probe?: { ok: boolean | null; message?: string; reason?: string } }>(
          "/v1/oma/model_cards",
          { method: "POST", body: JSON.stringify(payload) },
        );
        const probe = created.probe;
        if (probe?.ok === true) {
          toast.success(`Model card created — ${form.provider} key verified.`);
        } else if (probe?.ok === false) {
          toast.warning(
            probe.message
              ? `Model card saved but the key didn't work: ${probe.message}`
              : "Model card saved but the key didn't work — check api_key / base_url / model id.",
          );
        }
        // ok === null (unsupported provider) → no toast, success is implicit.
      }
      closeDialog(); load();
    } catch (e: any) { setError(e?.message || "Failed to save"); }
  };

  const remove = async (id: string) => {
    try { await api(`/v1/oma/model_cards/${id}`, { method: "DELETE" }); load(); } catch {}
  };

  const startEdit = (card: ModelCard) => {
    const hdrs = card.custom_headers
      ? Object.entries(card.custom_headers).map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
    if (hdrs.length === 0) hdrs.push({ key: "", value: "" });
    setForm({
      // Older rows on disk may carry a provider value outside the current
      // enum (e.g. legacy "anthropic"); the tile picker simply leaves none
      // selected in that case. Cast keeps the form state strictly typed.
      provider: card.provider as ProviderValue,
      model_id: card.model_id,
      model: card.model,
      api_key: "",
      base_url: card.base_url || "",
      is_default: card.is_default || false,
      pi_config: card.pi_config ? JSON.stringify(card.pi_config, null, 2) : "",
      custom_headers: hdrs,
    });
    setEditingId(card.id); setShowCreate(true); setError("");
  };

  const closeDialog = () => {
    setShowCreate(false); setEditingId(null); setForm({ ...INITIAL_FORM }); setError("");
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const providerLabel = (p: string) => PROVIDERS.find((x) => x.value === p)?.label || p;

  const providerBadge = (p: string) => {
    if (p === "anthropic" || p === "ant" || p === "ant-compatible") return "bg-warning-subtle text-warning";
    if (p === "openai" || p === "oai" || p === "oai-compatible") return "bg-success-subtle text-success";
    return "bg-bg-surface text-fg-muted";
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. The id+model_id
  // pair opts out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying. Actions also stays
  // visible — without Edit/Delete the table is read-only and there's
  // no detail page to drill into.
  const columns = useMemo<ColumnDef<ModelCard>[]>(
    () => [
      {
        id: "model_id",
        accessorKey: "model_id",
        header: "Model ID",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.model_id}</div>
            <div className="text-xs text-fg-subtle font-mono">{row.original.id}</div>
          </>
        ),
        enableHiding: false,
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: "API Format",
        cell: ({ row }) => (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${providerBadge(row.original.provider)}`}>
            {providerLabel(row.original.provider)}
          </span>
        ),
      },
      {
        id: "model",
        accessorKey: "model",
        header: "Wire Model",
        cell: ({ row }) =>
          row.original.model === row.original.model_id ? (
            <span className="text-fg-subtle">(same)</span>
          ) : (
            <span className="font-mono text-xs text-fg-muted">{row.original.model}</span>
          ),
      },
      {
        id: "api_key",
        accessorFn: (c) => c.api_key_preview ?? "",
        header: "API Key",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-subtle">
            ****{row.original.api_key_preview}
          </span>
        ),
      },
      {
        id: "base_url",
        accessorFn: (c) => c.base_url ?? "",
        header: "Base URL",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">{row.original.base_url || "—"}</span>
        ),
      },
      {
        id: "default",
        accessorFn: (c) => (c.is_default ? "default" : ""),
        header: "Default",
        cell: ({ row }) =>
          row.original.is_default ? (
            <span className="text-xs text-fg-muted bg-bg-surface px-1.5 py-0.5 rounded">
              default
            </span>
          ) : null,
      },
      {
        id: "created",
        accessorFn: (c) => c.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    // Intentionally empty: startEdit + remove close over `form`/`api`
    // but the column defs only need to reflect identity, not capture a
    // fresh closure on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Provider ▾" rather than "Provider: All ▾". The
  // clear-X only renders when the chip is in non-default state.
  const providerDisplay =
    provider === "any"
      ? undefined
      : PROVIDER_FILTER_OPTIONS.find((o) => o.value === provider)?.label;

  const filters = (
    <>
      <FilterChip
        label="Provider"
        active={provider !== "any"}
        display={providerDisplay}
        onClear={() => setProvider("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-56 p-0"
        >
          <FacetedFilter
            options={PROVIDER_FILTER_OPTIONS}
            value={provider}
            onValueChange={(v) => setProvider(v as ProviderValue | "any")}
            searchPlaceholder="Provider..."
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  return (
    <DataTable<ModelCard>
      createLabel="+ New model card"
      onCreate={() => { setShowCreate(true); setError(""); }}
      searchPlaceholder="Search model cards..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={cards}
      loading={loading}
      onRowClick={(c) => startEdit(c)}
      getRowId={(c) => c.id}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching model cards" : "No model cards yet"}
      emptyKind="model_card"
      emptyAction={
        !search && (
          <Button onClick={() => { setShowCreate(true); setError(""); }}>
            + New model card
          </Button>
        )
      }
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>Add a model card to configure API credentials for your agents.</p>
            <p className="text-xs mt-3">
              Without model cards, agents use the environment ANTHROPIC_API_KEY.
            </p>
          </>
        )
      }
      columns={columns}
    >
      <Modal open={showCreate} onClose={closeDialog} title={editingId ? "Edit Model Card" : "New Model Card"}
        footer={
          <>
            {editingId && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Delete model card ${form.model_id}? This can't be undone.`)) return;
                  await remove(editingId);
                  closeDialog();
                }}
                className="text-danger hover:text-danger hover:bg-danger-subtle mr-auto"
              >
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={closeDialog}>Cancel</Button>
            <Button onClick={save} disabled={!form.model_id || (!editingId && !form.api_key)}>{editingId ? "Save" : "Create"}</Button>
          </>
        }>
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-3">
          <LocalDebugOnlyWarning />
          {error && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <Label htmlFor="modelcard-id" className="text-sm text-fg-muted block mb-1">
              Model ID *
              <span className="ml-1 text-xs text-fg-subtle">(tenant-unique handle agents reference)</span>
            </Label>
            <TextInput id="modelcard-id" value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls}
              placeholder="claude-prod, claude-sonnet-4-6, bedrock-sonnet, ..." />
          </div>
          <div role="group" aria-labelledby="modelcard-provider-label">
            <span id="modelcard-provider-label" className="text-sm text-fg-muted block mb-1">Pi Provider *</span>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => (
                <Button variant="ghost"
                  key={p.value}
                  type="button"
                  aria-pressed={form.provider === p.value}
                  onClick={() => {
                    setForm({ ...form, provider: p.value, model: "", base_url: "" });
                    setAvailableModels([]);
                    void fetchModels(p.value);
                  }}
                  className={`text-left px-3 py-2 border rounded-md text-sm transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                    form.provider === p.value
                      ? "border-brand bg-brand-subtle text-fg"
                      : "border-border text-fg-muted hover:border-fg-subtle"
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-fg-subtle mt-0.5">{p.desc}</div>
                </Button>
              ))}
            </div>
            <TextInput
              value={form.provider}
              onChange={(e) => {
                setForm({ ...form, provider: e.target.value });
                setAvailableModels([]);
              }}
              onBlur={() => void fetchModels(form.provider)}
              className={`${inputCls} mt-2`}
              placeholder="Pi provider id, e.g. anthropic, deepseek, my-vllm"
              aria-label="Pi provider id"
            />
          </div>
          <div>
            <Label htmlFor="modelcard-api-key" className="text-sm text-fg-muted block mb-1">API Key {editingId ? "" : "*"}</Label>
            <SecretInput id="modelcard-api-key" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} className={inputCls}
              placeholder={editingId ? "Leave blank to keep current key" : "sk-..."}
              name="model-api-key-field" />
            {modelsLoading && (
              <p className="text-xs text-fg-subtle mt-1">Loading models...</p>
            )}
          </div>
          <div className="relative">
            <Label htmlFor="modelcard-wire-model" className="text-sm text-fg-muted block mb-1">
              Wire Model
              <span className="ml-1 text-xs text-fg-subtle">(sent to provider; defaults to Model ID)</span>
            </Label>
            <Input id="modelcard-wire-model" value={form.model}
              onChange={(e) => { setForm({ ...form, model: e.target.value }); setShowModelSuggestions(true); }}
              onFocus={() => {
                setShowModelSuggestions(true);
                if (availableModels.length === 0) void fetchModels(form.provider);
              }}
              onBlur={() => setTimeout(() => setShowModelSuggestions(false), 150)}
              className={inputCls}
              placeholder={form.model_id || "e.g. claude-sonnet-4-6, deepseek-v4-flash, org/model"}
              autoComplete="off" name="model-field" />
            {showModelSuggestions && availableModels.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-bg border border-border rounded-md shadow-lg py-1 max-h-48 overflow-y-auto">
                {availableModels
                  .filter((m) => !form.model || m.id.includes(form.model) || m.name.toLowerCase().includes(form.model.toLowerCase()))
                  .map((m) => (
                    <Button variant="ghost" key={m.id} type="button"
                      onMouseDown={() => { setForm({ ...form, model: m.id }); setShowModelSuggestions(false); }}
                      className="w-full text-left px-3 py-1.5 min-h-11 sm:min-h-0 text-sm hover:bg-bg-surface">
                      <span className="text-fg">{m.name !== m.id ? m.name : m.id}</span>
                      {m.name !== m.id && <span className="text-fg-subtle text-xs ml-2">{m.id}</span>}
                    </Button>
                  ))}
              </div>
            )}
            {!availableModels.length && !modelsLoading && form.provider && (
              <p className="text-xs text-fg-subtle mt-1">No Pi catalog entries loaded — enter a wire model manually for custom providers.</p>
            )}
          </div>
          <div>
            <Label htmlFor="modelcard-base-url" className="text-sm text-fg-muted block mb-1">Base URL <span className="text-fg-subtle">(optional for Pi built-ins)</span></Label>
            <Input id="modelcard-base-url" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={inputCls}
              placeholder="https://your-provider.example/v1" autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="modelcard-pi-config" className="text-sm text-fg-muted block mb-1">Pi Config <span className="text-fg-subtle">(JSON; custom provider requires api)</span></Label>
            <Textarea
              id="modelcard-pi-config"
              value={form.pi_config}
              onChange={(e) => setForm({ ...form, pi_config: e.target.value })}
              className={`${inputCls} min-h-24 font-mono`}
              placeholder={'{"api":"openai-completions","reasoning":false,"contextWindow":128000,"maxTokens":16384}'}
              spellCheck={false}
            />
          </div>
          <div>
              <Label className="text-sm text-fg-muted block mb-1">Custom Headers <span className="text-fg-subtle">(optional)</span></Label>
              <div className="space-y-1.5">
                {form.custom_headers.map((h, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Input value={h.key} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], key: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="Header-Name" aria-label={`Custom header ${i + 1} name`} autoComplete="off" />
                    <Input value={h.value} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], value: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="value" aria-label={`Custom header ${i + 1} value`} autoComplete="off" />
                    {form.custom_headers.length > 1 && (
                      <Button variant="ghost" type="button" onClick={() => setForm({ ...form, custom_headers: form.custom_headers.filter((_, j) => j !== i) })}
                        className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger text-xs shrink-0">Remove</Button>
                    )}
                  </div>
                ))}
                <Button variant="ghost" type="button" onClick={() => setForm({ ...form, custom_headers: [...form.custom_headers, { key: "", value: "" }] })}
                  className="inline-flex items-center justify-center min-h-11 sm:min-h-0 px-2 text-xs text-fg-muted hover:text-fg">+ Add header</Button>
              </div>
          </div>
          <Label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer">
            <Checkbox
              checked={form.is_default}
              onCheckedChange={(checked) =>
                setForm({ ...form, is_default: checked === true })
              }
            />
            Set as default model card
          </Label>
        </form>
      </Modal>
    </DataTable>
  );
}
