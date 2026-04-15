import { useEffect, useState, useCallback } from "react";
import { useApi } from "../lib/api";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

interface ModelCard {
  id: string; name: string;
  provider: string;
  model_id: string; api_key_preview?: string;
  base_url?: string; custom_headers?: Record<string, string>;
  is_default?: boolean;
  created_at: string; updated_at?: string;
}

const PROVIDERS = [
  { value: "ant", label: "Anthropic", desc: "Claude models" },
  { value: "ant-compatible", label: "Anthropic-compatible", desc: "Proxies speaking Anthropic API" },
  { value: "oai", label: "OpenAI", desc: "GPT models" },
  { value: "oai-compatible", label: "OpenAI-compatible", desc: "DeepSeek, Groq, Together, Ollama, etc." },
] as const;

const OFFICIAL_PROVIDERS = new Set(["ant", "oai"]);

const INITIAL_FORM = {
  name: "", provider: "ant",
  model_id: "", api_key: "", base_url: "", is_default: false,
  custom_headers: [{ key: "", value: "" }] as Array<{ key: string; value: string }>,
};

export function ModelCardsList() {
  const { api } = useApi();
  const [cards, setCards] = useState<ModelCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [error, setError] = useState("");
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");

  // Fetch models when API key changes for official providers
  const fetchModels = useCallback(async (provider: string, apiKey: string) => {
    if (!OFFICIAL_PROVIDERS.has(provider) || !apiKey || apiKey.length < 8) {
      setAvailableModels([]);
      return;
    }
    setModelsLoading(true);
    setModelsError("");
    try {
      const result = await api<{ data: Array<{ id: string; name: string }> }>("/v1/models/list", {
        method: "POST",
        body: JSON.stringify({ provider, api_key: apiKey }),
      });
      setAvailableModels(result.data);
    } catch (e: any) {
      setModelsError("Failed to load models. Check your API key.");
      setAvailableModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, [api]);

  const load = async () => {
    setLoading(true);
    try { setCards((await api<{ data: ModelCard[] }>("/v1/model_cards")).data); } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setError("");
    if (!form.name || !form.model_id || (!editingId && !form.api_key)) {
      setError("Name, Model ID, and API Key are required.");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        name: form.name, provider: form.provider, model_id: form.model_id,
        api_key: form.api_key, is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;
      // Serialize custom headers from array to object
      const hdrs: Record<string, string> = {};
      for (const h of form.custom_headers) {
        if (h.key && h.value) hdrs[h.key] = h.value;
      }
      if (Object.keys(hdrs).length > 0) payload.custom_headers = hdrs;
      if (editingId) {
        if (!form.api_key) delete payload.api_key;
        await api(`/v1/model_cards/${editingId}`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        await api("/v1/model_cards", { method: "POST", body: JSON.stringify(payload) });
      }
      closeDialog(); load();
    } catch (e: any) { setError(e?.message || "Failed to save"); }
  };

  const remove = async (id: string) => {
    try { await api(`/v1/model_cards/${id}`, { method: "DELETE" }); load(); } catch {}
  };

  const startEdit = (card: ModelCard) => {
    const hdrs = card.custom_headers
      ? Object.entries(card.custom_headers).map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
    if (hdrs.length === 0) hdrs.push({ key: "", value: "" });
    setForm({
      name: card.name, provider: card.provider, model_id: card.model_id,
      api_key: "", base_url: card.base_url || "", is_default: card.is_default || false,
      custom_headers: hdrs,
    });
    setEditingId(card.id); setShowCreate(true); setError("");
  };

  const closeDialog = () => {
    setShowCreate(false); setEditingId(null); setForm({ ...INITIAL_FORM }); setError("");
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

  const providerLabel = (p: string) => PROVIDERS.find((x) => x.value === p)?.label || p;

  const providerBadge = (provider: string) => {
    if (provider === "ant" || provider === "ant-compatible") return "bg-warning-subtle text-warning";
    if (provider === "oai" || provider === "oai-compatible") return "bg-success-subtle text-success";
    return "bg-bg-surface text-fg-muted";
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">Model Cards</h1>
          <p className="text-fg-muted text-sm">Configure model providers, API keys, and endpoints.</p>
        </div>
        <Button onClick={() => { setShowCreate(true); setError(""); }}>+ New model card</Button>
      </div>

      {loading ? (
        <div className="text-fg-subtle text-sm py-8 text-center">Loading...</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">No model cards yet</p>
          <p className="text-sm">Add a model card to configure API credentials for your agents.</p>
          <p className="text-xs mt-3">Without model cards, agents use the environment ANTHROPIC_API_KEY.</p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">API Format</th>
                <th className="text-left px-4 py-2.5">Model ID</th>
                <th className="text-left px-4 py-2.5">API Key</th>
                <th className="text-left px-4 py-2.5">Base URL</th>
                <th className="text-left px-4 py-2.5">Default</th>
                <th className="text-right px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-bg-surface transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-fg">{c.name}</div>
                    <div className="text-xs text-fg-subtle font-mono">{c.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${providerBadge(c.provider)}`}>{providerLabel(c.provider)}</span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted font-mono text-xs">{c.model_id}</td>
                  <td className="px-4 py-3 text-fg-subtle font-mono text-xs">****{c.api_key_preview}</td>
                  <td className="px-4 py-3 text-fg-muted text-xs truncate max-w-[200px]">{c.base_url || "\u2014"}</td>
                  <td className="px-4 py-3">{c.is_default && <span className="text-xs text-fg-muted bg-bg-surface px-1.5 py-0.5 rounded">default</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => startEdit(c)} className="text-xs text-fg-muted hover:text-fg mr-3">Edit</button>
                    <button onClick={() => remove(c.id)} className="text-xs text-fg-subtle hover:text-danger">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={showCreate} onClose={closeDialog} title={editingId ? "Edit Model Card" : "New Model Card"}
        footer={<><Button variant="ghost" onClick={closeDialog}>Cancel</Button><Button onClick={save} disabled={!form.name || !form.model_id || (!editingId && !form.api_key)}>{editingId ? "Save" : "Create"}</Button></>}>
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-3">
          {error && <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">{error}</div>}
          <div>
            <label className="text-sm text-fg-muted block mb-1">Name *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="My API Key" autoComplete="off" />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">API Format *</label>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => { setForm({ ...form, provider: p.value, model_id: "", base_url: "" }); setAvailableModels([]); setModelsError(""); }}
                  className={`text-left px-3 py-2 border rounded-md text-sm transition-colors ${
                    form.provider === p.value
                      ? "border-brand bg-brand-subtle text-fg"
                      : "border-border text-fg-muted hover:border-fg-subtle"
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="text-xs text-fg-subtle mt-0.5">{p.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">API Key {editingId ? "" : "*"}</label>
            <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} className={inputCls}
              placeholder={editingId ? "Leave blank to keep current key" : "sk-..."}
              autoComplete="new-password" name="model-api-key-field"
              onBlur={() => { if (OFFICIAL_PROVIDERS.has(form.provider) && form.api_key) fetchModels(form.provider, form.api_key); }} />
            {OFFICIAL_PROVIDERS.has(form.provider) && form.api_key && (
              <button type="button" onClick={() => fetchModels(form.provider, form.api_key)}
                className="text-xs text-brand hover:underline mt-1">
                {modelsLoading ? "Loading models..." : "Refresh model list"}
              </button>
            )}
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">Model ID *</label>
            {OFFICIAL_PROVIDERS.has(form.provider) && availableModels.length > 0 ? (
              <select value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls}>
                <option value="">Select model...</option>
                {availableModels.map((m) => <option key={m.id} value={m.id}>{m.name !== m.id ? `${m.name} (${m.id})` : m.id}</option>)}
              </select>
            ) : OFFICIAL_PROVIDERS.has(form.provider) ? (
              <div>
                <input value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls}
                  placeholder={form.provider === "ant" ? "claude-sonnet-4-6" : "gpt-4o"} autoComplete="off" name="model-id-field" />
                <p className="text-xs text-fg-subtle mt-1">
                  {modelsLoading ? "Loading models..." : modelsError ? modelsError : "Enter API key above to load available models."}
                </p>
              </div>
            ) : (
              <input value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls}
                placeholder="e.g. deepseek-chat, llama-3.1-70b, ..." autoComplete="off" name="model-id-field" />
            )}
          </div>
          {!OFFICIAL_PROVIDERS.has(form.provider) && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Base URL *</label>
              <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={inputCls}
                placeholder={form.provider === "ant-compatible" ? "https://your-proxy.com/v1" : "https://api.deepseek.com/v1"} autoComplete="off" />
            </div>
          )}
          {!OFFICIAL_PROVIDERS.has(form.provider) && (
            <div>
              <label className="text-sm text-fg-muted block mb-1">Custom Headers <span className="text-fg-subtle">(optional)</span></label>
              <div className="space-y-1.5">
                {form.custom_headers.map((h, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <input value={h.key} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], key: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="Header-Name" autoComplete="off" />
                    <input value={h.value} onChange={(e) => {
                      const hdrs = [...form.custom_headers];
                      hdrs[i] = { ...hdrs[i], value: e.target.value };
                      setForm({ ...form, custom_headers: hdrs });
                    }} className={inputCls} placeholder="value" autoComplete="off" />
                    {form.custom_headers.length > 1 && (
                      <button type="button" onClick={() => setForm({ ...form, custom_headers: form.custom_headers.filter((_, j) => j !== i) })}
                        className="text-fg-subtle hover:text-danger text-xs shrink-0">Remove</button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => setForm({ ...form, custom_headers: [...form.custom_headers, { key: "", value: "" }] })}
                  className="text-xs text-fg-muted hover:text-fg">+ Add header</button>
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="rounded accent-brand" />
            Set as default model card
          </label>
        </form>
      </Modal>
    </div>
  );
}
