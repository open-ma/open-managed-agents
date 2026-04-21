import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { LinearInstallation, LinearPublication } from "../api/types";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: LinearInstallation;
  publications: LinearPublication[];
}

export function IntegrationsLinearList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const installs = await api.listInstallations();
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.listPublications(installation.id),
        })),
      );
      setItems(withPubs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="px-6 py-5 max-w-5xl">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Linear integrations</h1>
          <p className="text-sm text-gray-500 mt-1">
            Make your agents teammates in Linear — assign them issues, mention them in
            comments, watch them push status.
          </p>
        </div>
        <Link
          to="/integrations/linear/publish"
          className="px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800"
        >
          + Publish agent to Linear
        </Link>
      </header>

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Error: {error}</p>}

      {!loading && items.length === 0 && (
        <div className="border border-dashed border-gray-300 rounded p-8 text-center">
          <p className="text-sm text-gray-600 mb-3">
            No Linear workspaces connected yet.
          </p>
          <Link
            to="/integrations/linear/publish"
            className="text-sm text-blue-600 hover:underline"
          >
            Publish your first agent →
          </Link>
        </div>
      )}

      <div className="space-y-4">
        {items.map(({ installation, publications }) => (
          <div
            key={installation.id}
            className="border border-gray-200 rounded p-4 hover:border-gray-300"
          >
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-medium">{installation.workspace_name}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  Dedicated app · full identity
                  {" · "}
                  {publications.length} agent{publications.length === 1 ? "" : "s"}
                </p>
              </div>
              <Link
                to={`/integrations/linear/installations/${installation.id}`}
                className="text-sm text-blue-600 hover:underline"
              >
                Manage →
              </Link>
            </div>

            {publications.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-100 grid gap-1.5">
                {publications.map((p) => (
                  <PublicationRow key={p.id} pub={p} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicationRow({ pub }: { pub: LinearPublication }) {
  return (
    <div className="flex items-center text-sm gap-2">
      {pub.persona.avatarUrl ? (
        <img
          src={pub.persona.avatarUrl}
          alt=""
          className="w-5 h-5 rounded-full"
        />
      ) : (
        <div className="w-5 h-5 rounded-full bg-gray-200 flex items-center justify-center text-xs">
          {pub.persona.name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <span className="font-medium">{pub.persona.name}</span>
      <StatusPill status={pub.status} />
    </div>
  );
}

function StatusPill({ status }: { status: LinearPublication["status"] }) {
  const map: Record<LinearPublication["status"], { label: string; cls: string }> = {
    live: { label: "Live", cls: "bg-green-100 text-green-700" },
    pending_setup: { label: "Pending setup", cls: "bg-gray-100 text-gray-600" },
    awaiting_install: { label: "Awaiting install", cls: "bg-amber-100 text-amber-700" },
    needs_reauth: { label: "Needs reauth", cls: "bg-red-100 text-red-700" },
    unpublished: { label: "Unpublished", cls: "bg-gray-100 text-gray-500" },
  };
  const v = map[status];
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${v.cls}`}>{v.label}</span>
  );
}
