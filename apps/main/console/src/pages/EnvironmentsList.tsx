import { useEffect, useState } from "react";
import { useApi } from "../lib/api";

interface Env { id: string; name: string; config: Record<string, unknown>; created_at: string; archived_at?: string; }

export function EnvironmentsList() {
  const { api } = useApi();
  const [envs, setEnvs] = useState<Env[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "" });

  const load = async () => {
    setLoading(true);
    try { setEnvs((await api<{ data: Env[] }>("/v1/environments?limit=100")).data); } catch {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const create = async () => {
    await api("/v1/environments", { method: "POST", body: JSON.stringify({ name: form.name, config: { type: "cloud" } }) });
    setShowCreate(false); setForm({ name: "" }); load();
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">Environments</h1>
          <p className="text-stone-500 text-sm">Configure sandbox environments for agent sessions.</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors">+ New environment</button>
      </div>
      {loading ? <div className="text-stone-400 text-sm py-8 text-center">Loading...</div> : envs.length === 0 ? (
        <div className="text-center py-16 text-stone-400"><p className="text-lg mb-1">No environments yet</p></div>
      ) : (
        <div className="border border-stone-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="bg-stone-100/60 text-stone-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-2.5">Name</th><th className="text-left px-4 py-2.5">ID</th><th className="text-left px-4 py-2.5">Type</th><th className="text-left px-4 py-2.5">Created</th>
            </tr></thead>
            <tbody>{envs.map((e) => (
              <tr key={e.id} className="border-t border-stone-100">
                <td className="px-4 py-3 font-medium">{e.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-stone-500">{e.id}</td>
                <td className="px-4 py-3 text-stone-600">{(e.config as any)?.type || "cloud"}</td>
                <td className="px-4 py-3 text-stone-500">{new Date(e.created_at).toLocaleDateString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {showCreate && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold mb-4">New Environment</h2>
            <div><label className="text-sm text-stone-600 block mb-1">Name</label>
              <input value={form.name} onChange={(e) => setForm({ name: e.target.value })} className="w-full border border-stone-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-stone-400" placeholder="production" />
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-stone-600">Cancel</button>
              <button onClick={create} disabled={!form.name} className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
