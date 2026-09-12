import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { useApi } from "../../lib/api";

/**
 * Right-rail panels mounted from `SessionDetail`. Kept here so the main
 * session orchestrator stays focused on event stream + chat scaffolding —
 * the panels are stand-alone fetch-and-display widgets that only need a
 * session/resource id and a close handler.
 *
 * Two flavors:
 *   - `ResourcePanel` — fetch + JSON-dump an agent / environment / vault.
 *     Used when the user clicks a badge in the session header.
 *   - `FilesPanel` — list files the agent wrote under
 *     `/mnt/session/outputs/`, with download links.
 */

export function ResourcePanel({
  panel,
  onClose,
}: {
  panel: { kind: "agent" | "environment" | "vault"; id: string };
  onClose: () => void;
}) {
  // Destructure the JSON call function from the shared transport object.
  // explicitly. A previous version assigned the whole object to `api` and
  // then called `api(url)`, which threw "api is not a function" and white-
  // screened the page on first badge click.
  const { api } = useApi();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    const url =
      panel.kind === "agent"
        ? `/v1/agents/${panel.id}`
        : panel.kind === "environment"
        ? `/v1/environments/${panel.id}`
        : `/v1/vaults/${panel.id}`;
    api<Record<string, unknown>>(url)
      .then((d) => setData(d))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // `api` from useApi() is a fresh closure every render — including it in
    // deps caused setData → re-render → new api → effect refire → infinite
    // loop. The stable inputs are kind + id; api itself is callable as-is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.kind, panel.id]);

  const linkPath =
    panel.kind === "agent"
      ? `/agents/${panel.id}`
      : panel.kind === "environment"
      ? `/environments/${panel.id}`
      : `/vaults/${panel.id}`;
  const titleKind = panel.kind[0].toUpperCase() + panel.kind.slice(1);

  // For agent / env, prefer name + description in the visible header.
  const displayName =
    (data?.name as string | undefined) ??
    (data?.display_name as string | undefined) ??
    panel.id;
  const description = (data?.description as string | undefined) ?? null;

  return (
    <aside className="w-[420px] shrink-0 bg-bg-surface/30 flex flex-col min-h-0">
      <div className="px-4 py-3 flex items-start gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-fg-subtle font-mono">
            {titleKind}
          </div>
          <div className="text-base font-semibold text-fg truncate">{displayName}</div>
          {description && (
            <div className="text-xs text-fg-muted mt-0.5 line-clamp-2">{description}</div>
          )}
          <div className="text-xs font-mono text-fg-subtle mt-1 truncate">{panel.id}</div>
        </div>
        <Button variant="ghost"
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          title="Close"
          aria-label="Close panel"
        >
          ×
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
        {err && <div className="text-danger">Failed to load: {err}</div>}
        {!data && !err && <div className="text-fg-subtle">Loading…</div>}
        {data && (
          <pre className="font-mono text-fg-muted bg-bg-surface/60 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
      <div className="px-4 py-3 shrink-0">
        <Link
          to={linkPath}
          className="inline-flex items-center gap-1.5 text-sm text-info hover:text-info/80 font-medium"
        >
          Go to {panel.kind} →
        </Link>
      </div>
    </aside>
  );
}

interface SessionOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function FilesPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { api } = useApi();
  const [files, setFiles] = useState<SessionOutputFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null);
    setErr(null);
    api<{ data: SessionOutputFile[]; has_more: boolean }>(
      `/v1/sessions/${sessionId}/outputs`,
    )
      .then((d) => setFiles(d.data ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // api closure changes every render; sessionId is the only stable input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <aside className="w-[420px] shrink-0 bg-bg-surface/30 flex flex-col min-h-0">
      <div className="px-4 py-3 flex items-start gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-fg-subtle font-mono">
            Files
          </div>
          <div className="text-base font-semibold text-fg">Session outputs</div>
          <div className="text-xs text-fg-muted mt-0.5">
            Files the agent wrote to <code className="font-mono">/mnt/session/outputs/</code>
          </div>
        </div>
        <Button variant="ghost"
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          title="Close"
          aria-label="Close panel"
        >
          ×
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-xs">
        {err && <div className="text-danger">Failed to load: {err}</div>}
        {!files && !err && <div className="text-fg-subtle">Loading…</div>}
        {files && files.length === 0 && (
          <div className="text-fg-subtle">
            No files yet. The agent must write under <code className="font-mono">/mnt/session/outputs/</code> for files to appear here.
          </div>
        )}
        {files && files.length > 0 && (
          <ul className="space-y-1.5">
            {files.map((f) => (
              <li
                key={f.filename}
                className="flex items-center gap-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <a
                    href={`/v1/sessions/${sessionId}/outputs/${encodeURIComponent(f.filename)}`}
                    download={f.filename}
                    className="font-mono text-fg hover:text-info truncate block"
                    title={f.filename}
                  >
                    {f.filename}
                  </a>
                  <div className="text-xs text-fg-subtle mt-0.5">
                    {formatBytes(f.size_bytes)} · {f.media_type} · {new Date(f.uploaded_at).toLocaleString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
