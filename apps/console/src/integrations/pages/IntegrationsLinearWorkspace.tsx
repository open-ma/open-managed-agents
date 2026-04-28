import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type {
  LinearInstallation,
  LinearPublication,
  LinearDispatchRule,
} from "../api/types";

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

const CAPABILITY_GROUPS: Array<{ label: string; caps: string[] }> = [
  { label: "Issues", caps: ["issue.read", "issue.create", "issue.update", "issue.delete"] },
  { label: "Comments", caps: ["comment.write", "comment.delete"] },
  { label: "Labels", caps: ["label.add", "label.remove"] },
  { label: "Assignment", caps: ["assignee.set", "assignee.set_other"] },
  { label: "Triage", caps: ["status.set", "priority.set"] },
  { label: "Other", caps: ["subissue.create", "user.mention", "search.read"] },
];

export function IntegrationsLinearWorkspace() {
  const { id } = useParams<{ id: string }>();
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
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-8 lg:px-10 py-8 lg:py-10">
        <Link
          to="/integrations/linear"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors"
        >
          ← Linear integrations
        </Link>

        {installation && (
          <header className="mt-3 mb-7 flex items-end justify-between gap-6">
            <div className="min-w-0">
              <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg truncate">
                {installation.workspace_name}
              </h1>
              <p className="mt-1.5 text-[14px] text-fg-muted">
                Dedicated apps · each agent has full identity in Linear
              </p>
            </div>
            <Link
              to={`/integrations/linear/publish?workspace=${id}`}
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
      setOpen(false);
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
    <div className="border border-border rounded-lg overflow-hidden bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-bg-surface/40 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {pub.persona.avatarUrl ? (
            <img src={pub.persona.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
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
              What this agent may do in Linear. Defaults to everything; uncheck to restrict.
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
      {open && <DispatchRulesSection publicationId={pub.id} />}
    </div>
  );
}

/**
 * Cron-driven autopilot rules for a publication. Each rule defines a filter
 * (label / state / project) — the cron sweep assigns matching unassigned
 * issues to this bot. Symphony-style "issue lands in Todo → bot picks it up
 * automatically", scoped per-publication.
 */
function DispatchRulesSection({ publicationId }: { publicationId: string }) {
  const [rules, setRules] = useState<LinearDispatchRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await api.listDispatchRules(publicationId);
      setRules(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => { void load(); }, [publicationId]);

  async function toggle(rule: LinearDispatchRule) {
    try {
      await api.updateDispatchRule(publicationId, rule.id, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove(rule: LinearDispatchRule) {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    try {
      await api.deleteDispatchRule(publicationId, rule.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="border-t border-border px-5 py-4 bg-bg-surface/30">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-[13px] font-medium text-fg">Autopilot rules</h4>
          <p className="text-[12px] text-fg-muted">
            Cron sweep assigns matching unassigned issues to this bot. At least one filter required (matching everything is a footgun).
          </p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="px-3 py-1.5 text-[12px] rounded-md border border-border hover:border-brand transition-colors"
        >
          {showCreate ? "Cancel" : "+ Add rule"}
        </button>
      </div>

      {error && <div className="mb-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/40 text-[12px] text-red-300">{error}</div>}

      {showCreate && (
        <CreateRuleForm
          publicationId={publicationId}
          onCreated={() => { setShowCreate(false); void load(); }}
        />
      )}

      {rules === null && <p className="text-[12px] text-fg-muted">Loading…</p>}
      {rules?.length === 0 && (
        <p className="text-[12px] text-fg-muted">No rules. Add one to enable autopilot.</p>
      )}
      {rules && rules.length > 0 && (
        <div className="space-y-2">
          {rules.map((r) => (
            <div key={r.id} className="border border-border rounded-md px-3 py-2 bg-bg flex items-center justify-between text-[12px]">
              <div className="min-w-0">
                <div className="font-medium text-fg flex items-center gap-2">
                  {r.name}
                  {!r.enabled && <span className="text-fg-subtle">(disabled)</span>}
                </div>
                <div className="text-fg-muted font-mono text-[11px] mt-0.5">
                  {r.filter_label && <>label=<code>{r.filter_label}</code> </>}
                  {r.filter_states && r.filter_states.length > 0 && <>states=<code>{r.filter_states.join(",")}</code> </>}
                  {r.filter_project_id && <>project=<code>{r.filter_project_id.slice(0, 8)}…</code> </>}
                  · max={r.max_concurrent} · poll={r.poll_interval_seconds}s
                  {r.last_polled_at && ` · last=${new Date(r.last_polled_at).toLocaleTimeString()}`}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => toggle(r)} className="px-2 py-1 text-[11px] hover:underline">
                  {r.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={() => remove(r)} className="px-2 py-1 text-[11px] text-danger hover:underline">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateRuleForm({
  publicationId,
  onCreated,
}: {
  publicationId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("Auto-pickup");
  const [label, setLabel] = useState("bot-ready");
  const [states, setStates] = useState("Todo");
  const [maxC, setMaxC] = useState(5);
  const [poll, setPoll] = useState(600);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim() && !states.trim()) {
      setError("Need at least a label or a state");
      return;
    }
    setWorking(true);
    try {
      await api.createDispatchRule(publicationId, {
        name: name.trim() || "Auto-pickup",
        filter_label: label.trim() || null,
        filter_states: states.trim() ? states.split(",").map((s) => s.trim()).filter(Boolean) : null,
        filter_project_id: null,
        max_concurrent: maxC,
        poll_interval_seconds: poll,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 border border-border rounded-md p-3 bg-bg space-y-2 text-[12px]">
      {error && <div className="px-2 py-1.5 rounded bg-red-500/10 border border-red-500/40 text-red-300">{error}</div>}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="px-2 py-1 border border-border rounded bg-bg" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Filter label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bot-ready" className="px-2 py-1 border border-border rounded bg-bg font-mono" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">States (comma)</span>
          <input value={states} onChange={(e) => setStates(e.target.value)} placeholder="Todo" className="px-2 py-1 border border-border rounded bg-bg font-mono" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Max concurrent</span>
          <input type="number" value={maxC} onChange={(e) => setMaxC(parseInt(e.target.value, 10) || 1)} min="1" max="100" className="px-2 py-1 border border-border rounded bg-bg" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted">Poll interval (s)</span>
          <input type="number" value={poll} onChange={(e) => setPoll(parseInt(e.target.value, 10) || 60)} min="60" max="86400" className="px-2 py-1 border border-border rounded bg-bg" />
        </label>
      </div>
      <button type="submit" disabled={working} className="px-3 py-1.5 bg-brand text-brand-fg rounded text-[12px] disabled:opacity-50">
        {working ? "Creating…" : "Create rule"}
      </button>
    </form>
  );
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-fg-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}
