import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { LinearInstallation, LinearPublication } from "../api/types";

const api = new IntegrationsApi();

const ALL_CAPABILITIES = [
  "issue.read",
  "issue.create",
  "issue.update",
  "issue.delete",
  "comment.write",
  "comment.delete",
  "label.add",
  "label.remove",
  "assignee.set",
  "assignee.set_other",
  "status.set",
  "priority.set",
  "subissue.create",
  "user.mention",
  "search.read",
] as const;

export function IntegrationsLinearWorkspace() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [installations, setInstallations] = useState<LinearInstallation[]>([]);
  const [publications, setPublications] = useState<LinearPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const [insts, pubs] = await Promise.all([
        api.listInstallations(),
        api.listPublications(id),
      ]);
      setInstallations(insts);
      setPublications(pubs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  const installation = installations.find((i) => i.id === id);

  return (
    <div className="px-6 py-5 max-w-3xl">
      <Link to="/integrations/linear" className="text-sm text-blue-600 hover:underline">
        ← Linear integrations
      </Link>
      {installation && (
        <header className="mt-3 mb-6">
          <h1 className="text-xl font-semibold">{installation.workspace_name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            Dedicated apps · each agent has full identity in Linear
          </p>
        </header>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="space-y-3">
        {publications.map((p) => (
          <PublicationCard key={p.id} pub={p} onChange={load} />
        ))}
      </div>
      <div className="mt-6">
        <Link
          to={`/integrations/linear/publish?workspace=${id}`}
          className="text-sm text-blue-600 hover:underline"
        >
          + Publish another agent
        </Link>
      </div>
    </div>
  );
}

function PublicationCard({
  pub,
  onChange,
}: {
  pub: LinearPublication;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<Set<string>>(new Set(pub.capabilities));
  const [personaName, setPersonaName] = useState(pub.persona.name);
  const [personaAvatar, setPersonaAvatar] = useState(pub.persona.avatarUrl ?? "");

  async function save() {
    setError(null);
    setWorking(true);
    try {
      await api.updatePublication(pub.id, {
        persona: { name: personaName, avatarUrl: personaAvatar || null },
        capabilities: [...caps],
      });
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function unpublish() {
    if (!confirm(`Unpublish ${pub.persona.name}? It will stop responding in Linear.`)) return;
    setWorking(true);
    try {
      await api.unpublish(pub.id);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  function toggleCap(cap: string) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }

  return (
    <div className="border border-gray-200 rounded">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-3 hover:bg-gray-50"
      >
        <div className="flex items-center gap-2 text-sm">
          {pub.persona.avatarUrl ? (
            <img src={pub.persona.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
          ) : (
            <div className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs">
              {pub.persona.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <span className="font-medium">{pub.persona.name}</span>
          <span className="text-xs text-gray-500">{pub.status}</span>
        </div>
        <span className="text-xs text-gray-400">{open ? "Hide" : "Edit"}</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 p-4 space-y-4 text-sm">
          {error && <p className="text-red-600 text-xs">{error}</p>}

          <div>
            <label className="block font-medium mb-1">Persona name</label>
            <input
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block font-medium mb-1">Avatar URL</label>
            <input
              value={personaAvatar}
              onChange={(e) => setPersonaAvatar(e.target.value)}
              placeholder="https://…"
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block font-medium mb-1">Capabilities</label>
            <p className="text-xs text-gray-500 mb-2">
              What this agent may do in Linear. Defaults to everything; uncheck to restrict.
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {ALL_CAPABILITIES.map((cap) => (
                <label key={cap} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={caps.has(cap)}
                    onChange={() => toggleCap(cap)}
                  />
                  <code className="text-gray-600">{cap}</code>
                </label>
              ))}
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between">
            <button
              onClick={save}
              disabled={working}
              className="px-3 py-1.5 bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50 text-xs"
            >
              {working ? "Saving…" : "Save"}
            </button>
            <button
              onClick={unpublish}
              disabled={working}
              className="text-xs text-red-600 hover:underline disabled:opacity-50"
            >
              Unpublish
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
