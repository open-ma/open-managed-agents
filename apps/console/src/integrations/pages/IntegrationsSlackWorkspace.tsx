import { Children, cloneElement, isValidElement, useEffect, useId, useState, type ReactElement } from "react";
import { Link, useParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { SlackInstallation, SlackPublication } from "../api/types";

const api = new IntegrationsApi();

const ALL_CAPABILITIES = [
  "message.read",
  "message.write",
  "message.update",
  "message.delete",
  "thread.reply",
  "reaction.add",
  "reaction.remove",
  "user.read",
  "search.read",
  "canvas.write",
] as const;

const CAPABILITY_GROUPS: Array<{ label: string; caps: string[] }> = [
  { label: "Messages", caps: ["message.read", "message.write", "message.update", "message.delete"] },
  { label: "Threads", caps: ["thread.reply"] },
  { label: "Reactions", caps: ["reaction.add", "reaction.remove"] },
  { label: "People & search", caps: ["user.read", "search.read"] },
  { label: "Other", caps: ["canvas.write"] },
];

export function IntegrationsSlackWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [installations, setInstallations] = useState<SlackInstallation[]>([]);
  const [publications, setPublications] = useState<SlackPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const [insts, pubs] = await Promise.all([
        api.slack.listInstallations(),
        api.slack.listPublications(id),
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-8 lg:px-10 py-8 lg:py-10">
        <Link
          to="/integrations/slack"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors"
        >
          ← Slack integrations
        </Link>

        {installation && (
          <header className="mt-3 mb-7 flex items-end justify-between gap-6">
            <div className="min-w-0">
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg truncate">
                {installation.workspace_name}
              </h1>
              <p className="mt-1.5 text-[14px] text-fg-muted">
                Dedicated apps · each agent has full identity in Slack
              </p>
            </div>
            <Link
              to={`/integrations/slack/publish?workspace=${id}`}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors whitespace-nowrap"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              Publish another
            </Link>
          </header>
        )}

        {loading && <p className="text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="space-y-3">
          {publications.map((p) => (
            <PublicationCard key={p.id} pub={p} onChange={load} />
          ))}
        </div>

        {!loading && publications.length === 0 && (
          <div className="border border-border rounded-lg px-6 py-12 text-center bg-bg-surface/30">
            <div className="font-mono text-fg-subtle text-sm select-none mb-3">[ &nbsp;&nbsp; ]</div>
            <p className="text-sm text-fg">No agents published yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function PublicationCard({
  pub,
  onChange,
}: {
  pub: SlackPublication;
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
      await api.slack.updatePublication(pub.id, {
        persona: { name: personaName, avatarUrl: personaAvatar || null },
        capabilities: [...caps],
      });
      setOpen(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function unpublish() {
    if (!confirm(`Unpublish ${pub.persona.name}? It will stop responding in Slack.`)) return;
    setWorking(true);
    try {
      await api.slack.unpublish(pub.id);
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
    <div className="border border-border rounded-lg overflow-hidden bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-bg-surface/40 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {pub.persona.avatarUrl ? (
            <img src={pub.persona.avatarUrl} alt="" loading="lazy" decoding="async" className="w-7 h-7 rounded-full shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-brand-subtle text-brand flex items-center justify-center text-[12px] font-medium shrink-0">
              {pub.persona.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-fg truncate">{pub.persona.name}</div>
            <div className="text-[11px] text-fg-muted font-mono uppercase tracking-wider">
              {pub.status}
            </div>
          </div>
        </div>
        <span className="shrink-0 text-[12px] text-fg-muted">
          {open ? "Hide" : "Edit"} {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="border-t border-border p-5 space-y-5 text-sm bg-bg-surface/20">
          {error && (
            <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
              {error}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Persona name">
              <input
                value={personaName}
                onChange={(e) => setPersonaName(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Avatar URL">
              <input
                value={personaAvatar}
                onChange={(e) => setPersonaAvatar(e.target.value)}
                placeholder="https://…"
                className={inputCls}
              />
            </Field>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="text-[13px] font-medium text-fg">Capabilities</label>
              <span className="text-[12px] text-fg-muted">
                {caps.size} of {ALL_CAPABILITIES.length} enabled
              </span>
            </div>
            <p className="text-[12px] text-fg-muted mb-3">
              What this agent may do in Slack. Defaults to everything; uncheck to restrict.
            </p>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4">
              {CAPABILITY_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="font-mono text-[10px] tracking-wider text-fg-subtle uppercase mb-1.5">
                    {g.label}
                  </div>
                  <div className="space-y-1">
                    {g.caps.map((cap) => (
                      <label
                        key={cap}
                        className="flex items-center gap-2 text-[12px] cursor-pointer hover:text-fg text-fg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={caps.has(cap)}
                          onChange={() => toggleCap(cap)}
                          className="accent-brand"
                        />
                        <code className="font-mono">{cap}</code>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-2 flex items-center justify-between border-t border-border -mx-5 px-5 -mb-5 pb-5 mt-5">
            <button
              onClick={save}
              disabled={working}
              className="px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {working ? "Saving…" : "Save changes"}
            </button>
            <button
              onClick={unpublish}
              disabled={working}
              className="text-[12px] text-danger hover:underline disabled:opacity-50"
            >
              Unpublish agent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const generatedId = useId();
  // Clone the child input/select/textarea so it shares the same id the
  // <label htmlFor> points at. Saves callsites from threading ids manually.
  const child = Children.only(children) as ReactElement<{ id?: string }>;
  const childWithId = isValidElement(child) && !child.props.id
    ? cloneElement(child, { id: generatedId })
    : child;
  return (
    <div>
      <label htmlFor={(childWithId.props as { id?: string }).id ?? generatedId} className="block text-[12px] font-medium text-fg-muted mb-1.5">{label}</label>
      {childWithId}
    </div>
  );
}
