import { useEffect, useState } from "react";
import { Link } from "react-router";
import { IntegrationsApi } from "../api/client";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import type { SlackInstallation, SlackPublication } from "../api/types";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: SlackInstallation;
  publications: SlackPublication[];
}

export function IntegrationsSlackList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const installs = await api.slack.listInstallations();
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.slack.listPublications(installation.id),
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="flex items-start justify-between gap-6 mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
              Slack integrations
            </h1>
            <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
              Make your agents teammates in Slack — @-mention them, DM them, watch them
              reply in threads.
            </p>
          </div>
          <Link
            to="/integrations/slack/publish"
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] whitespace-nowrap"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Publish agent
          </Link>
        </header>

        {loading && <p className="text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {!loading && items.length === 0 && (
          <EmptyState
            title="No Slack workspaces connected yet."
            action={
              <Link
                to="/integrations/slack/publish"
                className="text-brand hover:underline text-[13px]"
              >
                Publish your first agent →
              </Link>
            }
          />
        )}

        <div className="space-y-3">
          {items.map(({ installation, publications }) => (
            <WorkspaceCard
              key={installation.id}
              installation={installation}
              publications={publications}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkspaceCard({
  installation,
  publications,
}: {
  installation: SlackInstallation;
  publications: SlackPublication[];
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-medium text-fg truncate">
              {installation.workspace_name}
            </h2>
            <span className="text-[11px] text-fg-subtle font-mono uppercase tracking-wider">
              workspace
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            Dedicated app · full identity ·{" "}
            <span className="text-fg">
              {publications.length} agent{publications.length === 1 ? "" : "s"}
            </span>
          </p>
        </div>
        <Link
          to={`/integrations/slack/installations/${installation.id}`}
          className="shrink-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          Manage →
        </Link>
      </div>

      {publications.length > 0 && (
        <ul className="border-t border-border divide-y divide-border bg-bg-surface/20">
          {publications.map((p) => (
            <PublicationRow key={p.id} pub={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PublicationRow({ pub }: { pub: SlackPublication }) {
  return (
    <li className="flex items-center gap-3 px-5 py-2.5 text-sm">
      <Avatar src={pub.persona.avatarUrl} name={pub.persona.name} size="sm" />
      <span className="font-medium text-fg flex-1 truncate">{pub.persona.name}</span>
      <StatusPill status={pub.status} />
    </li>
  );
}

function StatusPill({ status }: { status: SlackPublication["status"] }) {
  const map: Record<
    SlackPublication["status"],
    { label: string; cls: string; dot: string }
  > = {
    live: {
      label: "Live",
      cls: "text-success bg-success-subtle",
      dot: "bg-success",
    },
    pending_setup: {
      label: "Pending setup",
      cls: "text-fg-muted bg-bg-surface",
      dot: "bg-fg-muted",
    },
    awaiting_install: {
      label: "Awaiting install",
      cls: "text-warning bg-warning-subtle",
      dot: "bg-warning",
    },
    needs_reauth: {
      label: "Needs reauth",
      cls: "text-danger bg-danger-subtle",
      dot: "bg-danger",
    },
    unpublished: {
      label: "Unpublished",
      cls: "text-fg-subtle bg-bg-surface",
      dot: "bg-fg-subtle",
    },
  };
  const v = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full ${v.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${v.dot}`} />
      {v.label}
    </span>
  );
}
