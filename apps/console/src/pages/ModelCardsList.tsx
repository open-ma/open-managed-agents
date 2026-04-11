import { useEffect, useState } from "react";
import { useApi } from "../lib/api";

interface ModelCard {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "custom";
  model_id: string;
  api_key_preview?: string;
  base_url?: string;
  is_default?: boolean;
  created_at: string;
  updated_at?: string;
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "Custom" },
] as const;

const INITIAL_FORM = {
  name: "",
  provider: "anthropic" as "anthropic" | "openai" | "custom",
  model_id: "",
  api_key: "",
  base_url: "",
  is_default: false,
};

export function ModelCardsList() {
  const { api } = useApi();
  const [cards, setCards] = useState<ModelCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ data: ModelCard[] }>("/v1/model_cards");
      setCards(data.data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setError("");
    if (!form.name || !form.model_id || !form.api_key) {
      setError("Name, Model ID, and API Key are required.");
      return;
    }

    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        provider: form.provider,
        model_id: form.model_id,
        api_key: form.api_key,
        is_default: form.is_default,
      };
      if (form.base_url) payload.base_url = form.base_url;

      if (editingId) {
        await api(`/v1/model_cards/${editingId}`, { method: "POST", body: JSON.stringify(payload) });
      } else {
        await api("/v1/model_cards", { method: "POST", body: JSON.stringify(payload) });
      }
      closeDialog();
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to save");
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/v1/model_cards/${id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  const startEdit = (card: ModelCard) => {
    setForm({
      name: card.name,
      provider: card.provider,
      model_id: card.model_id,
      api_key: "",
      base_url: card.base_url || "",
      is_default: card.is_default || false,
    });
    setEditingId(card.id);
    setShowCreate(true);
    setError("");
  };

  const closeDialog = () => {
    setShowCreate(false);
    setEditingId(null);
    setForm({ ...INITIAL_FORM });
    setError("");
  };

  const inputCls = "w-full border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-stone-400 transition-colors";

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Model Cards</h1>
          <p className="text-stone-500 text-sm">Configure model providers, API keys, and base URLs.</p>
        </div>
        <button onClick={() => { setShowCreate(true); setError(""); }} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors">
          + New model card
        </button>
      </div>

      {loading ? (
        <div className="text-stone-400 text-sm py-8 text-center">Loading...</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-16 text-stone-400">
          <p className="text-lg mb-1">No model cards yet</p>
          <p className="text-sm">Add a model card to configure API credentials for your agents.</p>
          <p className="text-xs mt-3 text-stone-400">Without model cards, agents use the environment ANTHROPIC_API_KEY.</p>
        </div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-stone-100/60 text-stone-500 text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Name</th>
                <th className="text-left px-4 py-2.5">Provider</th>
                <th className="text-left px-4 py-2.5">Model ID</th>
                <th className="text-left px-4 py-2.5">API Key</th>
                <th className="text-left px-4 py-2.5">Base URL</th>
                <th className="text-left px-4 py-2.5">Default</th>
                <th className="text-right px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <tr key={c.id} className="border-t border-stone-100 hover:bg-stone-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-stone-400 font-mono">{c.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      c.provider === "anthropic" ? "bg-amber-100 text-amber-700" :
                      c.provider === "openai" ? "bg-green-100 text-green-700" :
                      "bg-stone-100 text-stone-600"
                    }`}>{c.provider}</span>
                  </td>
                  <td className="px-4 py-3 text-stone-600 font-mono text-xs">{c.model_id}</td>
                  <td className="px-4 py-3 text-stone-400 font-mono text-xs">****{c.api_key_preview}</td>
                  <td className="px-4 py-3 text-stone-500 text-xs truncate max-w-[200px]">{c.base_url || "—"}</td>
                  <td className="px-4 py-3">{c.is_default && <span className="text-xs text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded">default</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => startEdit(c)} className="text-xs text-stone-500 hover:text-stone-900 mr-3">Edit</button>
                    <button onClick={() => remove(c.id)} className="text-xs text-stone-400 hover:text-red-500">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={closeDialog}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-4 border-b border-stone-100">
              <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">
                {editingId ? "Edit Model Card" : "New Model Card"}
              </h2>
            </div>
            <div className="px-6 py-4 space-y-3">
              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
              <div>
                <label className="text-sm text-stone-600 block mb-1">Name *</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="My Anthropic Key" />
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Provider</label>
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as typeof form.provider })} className={inputCls}>
                  {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Model ID *</label>
                <input value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })} className={inputCls} placeholder="claude-sonnet-4-6" />
                <p className="text-xs text-stone-400 mt-1">The model identifier used in agent configs.</p>
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">API Key *</label>
                <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} className={inputCls}
                  placeholder={editingId ? "Leave blank to keep current key" : "sk-ant-..."} />
              </div>
              <div>
                <label className="text-sm text-stone-600 block mb-1">Base URL</label>
                <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} className={inputCls} placeholder="https://api.anthropic.com" />
                <p className="text-xs text-stone-400 mt-1">Optional. Override the default API endpoint.</p>
              </div>
              <label className="flex items-center gap-2 text-sm text-stone-600 cursor-pointer">
                <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="rounded" />
                Set as default model card
              </label>
            </div>
            <div className="px-6 py-4 border-t border-stone-100 flex justify-end gap-2">
              <button onClick={closeDialog} className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900">Cancel</button>
              <button onClick={save} disabled={!form.name || !form.model_id || (!editingId && !form.api_key)}
                className="px-5 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40 transition-colors">
                {editingId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
