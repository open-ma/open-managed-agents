import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type {
  GitHubInstallation,
  GitHubPublication,
  GitHubSessionMetadata,
  SessionSummary,
} from "../api/types";
import { StatusPill } from "../components/StatusPill";
import { relativeTime } from "../components/relativeTime";

const api = new IntegrationsApi();

// GitHub-flavored capability set. Mirrors what packages/github exports.
// Sandbox-side `gh`/`git` operations don't get gated by these — they
// inherit the App's per-install GitHub permissions. The OMA-side caps
// are the user's expression of intent for future-MCP and audit display.
const CAPABILITY_GROUPS: Array<{ label: string; caps: string[] }> = [
  { label: "Issues", caps: ["issue.read", "issue.create", "issue.update", "issue.delete"] },
  { label: "Pull Requests", caps: ["pr.read", "pr.create", "pr.update", "pr.review.write", "pr.review.comment", "pr.close", "pr.merge"] },
  { label: "Comments", caps: ["comment.write", "comment.delete"] },
  { label: "Labels", caps: ["label.add", "label.remove"] },
  { label: "Assignment", caps: ["assignee.set", "assignee.set_other"] },
  { label: "Repo", caps: ["repo.read", "repo.write", "repo.branch.create", "repo.branch.delete"] },
  { label: "Workflows", caps: ["workflow.read", "workflow.dispatch", "release.read", "release.create"] },
  { label: "Other", caps: ["status.set", "user.mention", "search.read"] },
];

// Hard-coded snapshot of the default-mode wakeup matrix — derived from
// packages/github/src/webhook/parse.ts which dispatches on assigned-to-bot,
// review_requested-of-bot, and @mentions only. Future per-publication
// modes (e.g. --mode triage adds issue.opened) will need this list to
// become a function of publication.session_granularity / mode flags.
const WAKEUP_EVENTS: Array<{ kind: string; description: string }> = [
  { kind: "issue_assigned", description: "Issue assigned to bot" },
  { kind: "pr_assigned", description: "Pull request assigned to bot" },
  { kind: "pr_review_requested", description: "Pull request review requested" },
  { kind: "issue_mentioned", description: "@mention in issue comment" },
  { kind: "pr_mentioned", description: "@mention in PR comment or review" },
  { kind: "pr_review_submitted", description: "Pull request review submitted (when bot was reviewer)" },
];

export function IntegrationsGitHubWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [publications, setPublications] = useState<GitHubPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    try {
      const [insts, pubs] = await Promise.all([
        api.github.listInstallations(),
        api.github.listPublications(id),
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
  // Derive a single status for the workspace header. `live` if any pub is
  // live; otherwise reflect the most "in-progress" state. A workspace with
  // zero pubs gets pending_setup so the pill never renders blank.
  const headerStatus = computeWorkspaceStatus(publications);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <Link
          to="/integrations/github"
          className="inline-block mb-6 text-[13px] text-fg-muted hover:text-brand transition-colors"
        >
          ← All GitHub installations
        </Link>

        {loading && <p className="text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {!loading && !installation && id && (
          <NotFound id={id} />
        )}

        {installation && (
          <>
            <BotIdentityCard
              installation={installation}
              status={headerStatus}
              publicationCount={publications.length}
            />

            <div className="grid lg:grid-cols-[1fr_280px] gap-6 mt-8">
              <div className="min-w-0 space-y-8">
                <section>
                  <SectionHeading
                    title={publications.length === 1 ? "Bound agent" : "Bound agents"}
                    hint={`${publications.length} of this org's bots`}
                  />
                  {publications.length === 0 ? (
                    <div className="border border-border rounded-lg px-6 py-10 text-center bg-bg-surface/30">
                      <div className="font-mono text-fg-subtle text-sm select-none mb-3">[ &nbsp;&nbsp; ]</div>
                      <p className="text-sm text-fg">No agents bound to this org.</p>
                      <p className="text-[13px] text-fg-muted mt-1.5">
                        <Link to="/integrations/github/bind" className="text-brand hover:underline">
                          Bind one →
                        </Link>
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {publications.map((p) => (
                        <PublicationCard key={p.id} pub={p} onUpdate={load} />
                      ))}
                    </div>
                  )}
                </section>

                <ActivitySection installation={installation} />
              </div>

              <aside className="min-w-0">
                <WakesUpOn />
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <div className="border border-border rounded-lg px-6 py-10 text-center bg-bg-surface/30">
      <div className="font-mono text-fg-subtle text-sm select-none mb-3">[ ?  ]</div>
      <p className="text-sm text-fg">Installation not found.</p>
      <p className="text-[13px] text-fg-muted mt-1.5">
        <code className="font-mono text-fg-muted">{id}</code> doesn't match any
        GitHub installation on this account. It may have been removed, or you
        may be signed in as a different user.
      </p>
      <Link
        to="/integrations/github"
        className="mt-4 inline-block text-[13px] text-brand hover:underline"
      >
        ← Back to GitHub integrations
      </Link>
    </div>
  );
}

function BotIdentityCard({
  installation,
  status,
  publicationCount,
}: {
  installation: GitHubInstallation;
  status: ReturnType<typeof computeWorkspaceStatus>;
  publicationCount: number;
}) {
  // GitHub bot logins are always `<slug>[bot]`. Render the slug in the
  // dominant mono weight and keep the `[bot]` suffix muted — the suffix is
  // GitHub's bookkeeping, the slug is the agent's identity.
  const { slug, suffix } = splitBotLogin(installation.bot_login);

  return (
    <div className="border border-border rounded-lg p-5 bg-bg">
      <div className="flex items-start justify-between gap-5">
        <div className="flex items-start gap-4 min-w-0">
          <BotAvatar login={installation.bot_login} />
          <div className="min-w-0">
            <h1 className="font-display text-[26px] leading-tight font-semibold tracking-tight text-fg truncate">
              {installation.workspace_name}
            </h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              acting as{" "}
              <code className="font-mono text-fg">
                @{slug}
                {suffix && (
                  <span className="text-fg-muted">{suffix}</span>
                )}
              </code>
            </p>
          </div>
        </div>
        <StatusPill status={status} size="md" />
      </div>
      <div className="mt-4 pt-4 border-t border-border flex items-center gap-4 text-[12px] text-fg-muted">
        <span>
          Installed{" "}
          <span className="text-fg">{relativeTime(installation.created_at)}</span>
        </span>
        <span className="text-border-strong">·</span>
        <span>
          <span className="text-fg">{publicationCount}</span> agent{publicationCount === 1 ? "" : "s"} bound
        </span>
        <span className="text-border-strong">·</span>
        <span>
          installation_id{" "}
          <code className="font-mono text-fg">{installation.workspace_id}</code>
        </span>
      </div>
    </div>
  );
}

function BotAvatar({ login }: { login: string }) {
  // Square-with-rounded-corners deliberately echoes GitHub's app-icon
  // affordance (their bots render as squares in the UI), while keeping
  // brand color intact. The first letter is the slug's, never the [bot]
  // suffix.
  const slug = login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
  const initial = slug.slice(0, 1).toUpperCase() || "B";
  return (
    <div className="w-12 h-12 rounded-lg bg-brand-subtle text-brand flex items-center justify-center font-display text-[20px] font-semibold shrink-0">
      {initial}
    </div>
  );
}

function splitBotLogin(login: string): { slug: string; suffix: string | null } {
  if (login.endsWith("[bot]")) {
    return { slug: login.slice(0, -"[bot]".length), suffix: "[bot]" };
  }
  return { slug: login, suffix: null };
}

function computeWorkspaceStatus(
  pubs: GitHubPublication[],
): GitHubPublication["status"] {
  if (pubs.length === 0) return "pending_setup";
  // Order of severity, lowest-priority last.
  const order: GitHubPublication["status"][] = [
    "needs_reauth",
    "awaiting_install",
    "pending_setup",
    "live",
    "unpublished",
  ];
  for (const s of order) {
    if (pubs.some((p) => p.status === s)) return s;
  }
  return "pending_setup";
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="font-display text-[18px] font-semibold text-fg tracking-tight">
        {title}
      </h2>
      {hint && <span className="text-[12px] text-fg-muted">{hint}</span>}
    </div>
  );
}

function WakesUpOn() {
  return (
    <section>
      <h2 className="font-display text-[18px] font-semibold text-fg tracking-tight mb-3">
        Wakes up on
      </h2>
      <ul className="space-y-3">
        {WAKEUP_EVENTS.map((e) => (
          <li key={e.kind} className="flex items-start gap-2.5 text-[12px]">
            <code className="bg-bg-surface text-fg-muted px-2 py-0.5 rounded text-[11px] font-mono shrink-0 mt-0.5">
              {e.kind}
            </code>
            <span className="text-fg-muted leading-snug">{e.description}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] text-fg-subtle leading-relaxed">
        Default matrix. Self-mentions, sender-is-bot, and unmentioned comments
        never wake the bot.
      </p>
    </section>
  );
}

function ActivitySection({ installation }: { installation: GitHubInstallation }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch latest sessions and filter to ones whose metadata.github.installationId
  // matches this workspace's numeric installation id. /v1/sessions doesn't
  // support server-side metadata filtering yet — for v0 we accept the
  // overhead since the user's session count is bounded.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listSessions({ limit: 50 })
      .then((data) => {
        if (!alive) return;
        const matching = data.filter((s) => {
          const meta = (s.metadata?.github as GitHubSessionMetadata | undefined) ?? null;
          return meta?.installationId === installation.workspace_id;
        });
        setSessions(matching);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [installation.workspace_id]);

  return (
    <section>
      <SectionHeading
        title="Recent activity"
        hint={sessions ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : undefined}
      />
      {loading && <p className="text-[13px] text-fg-muted">Loading…</p>}
      {err && (
        <p className="text-[13px] text-fg-muted">
          Couldn't load activity: <span className="text-danger">{err}</span>
        </p>
      )}
      {!loading && sessions && sessions.length === 0 && (
        <div className="border border-border rounded-lg px-6 py-10 text-center bg-bg-surface/30">
          <div className="font-mono text-fg-subtle text-sm select-none mb-3">[ &nbsp;&nbsp; ]</div>
          <p className="text-sm text-fg">No webhook deliveries yet.</p>
          <p className="text-[13px] text-fg-muted mt-1.5">
            Try assigning a GitHub issue to{" "}
            <code className="font-mono text-fg">@{installation.bot_login}</code> or
            mentioning the bot in a comment.
          </p>
        </div>
      )}
      {sessions && sessions.length > 0 && (
        <ul className="border border-border rounded-lg divide-y divide-border bg-bg overflow-hidden">
          {sessions.map((s) => (
            <ActivityRow key={s.id} session={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({ session }: { session: SessionSummary }) {
  const meta = (session.metadata?.github as GitHubSessionMetadata | undefined) ?? null;
  const eventKind = meta?.eventKind ?? meta?.eventType ?? "event";
  const where = meta?.repository
    ? `${meta.repository}${meta.itemNumber != null ? `#${meta.itemNumber}` : ""}`
    : "—";
  return (
    <li className="px-5 py-3 text-[13px] flex items-center gap-3">
      <code className="bg-bg-surface text-fg-muted px-2 py-0.5 rounded text-[11px] font-mono shrink-0">
        {eventKind}
      </code>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-fg truncate text-[12px]">{where}</div>
        <div className="text-[11px] text-fg-muted">
          {relativeTime(session.created_at)}
          {meta?.actorLogin && (
            <>
              {" · by "}
              <code className="font-mono text-fg-muted">@{meta.actorLogin}</code>
            </>
          )}
        </div>
      </div>
      {meta?.htmlUrl ? (
        <a
          href={meta.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-[12px] text-fg-muted hover:text-brand transition-colors"
        >
          View on GitHub →
        </a>
      ) : (
        <span className="shrink-0 text-[11px] font-mono text-fg-subtle truncate max-w-[160px]">
          {session.id}
        </span>
      )}
    </li>
  );
}

function PublicationCard({
  pub,
  onUpdate,
}: {
  pub: GitHubPublication;
  onUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [caps, setCaps] = useState<Set<string>>(new Set(pub.capabilities));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api.github.updatePublication(pub.id, { capabilities: [...caps] });
      setEditing(false);
      onUpdate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function unbind() {
    if (!confirm(`Unbind "${pub.persona.name}"? The bot will stop responding to GitHub events.`)) return;
    try {
      await api.github.unpublish(pub.id);
      onUpdate();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="border border-border rounded-lg bg-bg overflow-hidden">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3 min-w-0">
          {pub.persona.avatarUrl ? (
            <img src={pub.persona.avatarUrl} alt="" loading="lazy" decoding="async" className="w-8 h-8 rounded-full shrink-0" />
          ) : (
            <div className="w-8 h-8 rounded-full bg-brand-subtle text-brand flex items-center justify-center text-[12px] font-medium shrink-0">
              {pub.persona.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-fg truncate">{pub.persona.name}</div>
            <div className="text-[12px] text-fg-muted flex items-center gap-1.5 flex-wrap">
              <StatusPill status={pub.status} />
              <span className="text-fg-subtle">·</span>
              <span>
                agent{" "}
                <code className="font-mono text-fg">
                  {pub.agent_id.slice(0, 12)}
                </code>
                <span className="text-fg-subtle">…</span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEditing(!editing)}
            className="text-[13px] text-fg-muted hover:text-brand transition-colors px-3 py-1.5"
          >
            {editing ? "Cancel" : "Edit caps"}
          </button>
          <button
            onClick={unbind}
            className="text-[13px] text-danger hover:underline px-3 py-1.5"
          >
            Unbind
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-border p-5 bg-bg-surface/30 space-y-6">
          {CAPABILITY_GROUPS.map((g) => {
            // Hide a group entirely when its enumerated caps don't intersect
            // anything renderable — currently every group has at least one
            // cap, but this keeps the layout honest if the constant changes.
            if (g.caps.length === 0) return null;
            return (
              <div key={g.label}>
                <h3 className="text-[10px] uppercase tracking-wider text-fg-subtle font-mono mb-2">
                  {g.label}
                </h3>
                <div className="flex flex-wrap gap-1">
                  {g.caps.map((c) => (
                    <label
                      key={c}
                      className={`inline-flex items-center gap-1.5 text-[12px] px-2 py-1 border rounded cursor-pointer transition-colors ${
                        caps.has(c)
                          ? "border-brand bg-brand-subtle text-brand"
                          : "border-border text-fg-muted hover:border-fg-muted"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={caps.has(c)}
                        onChange={(e) => {
                          const next = new Set(caps);
                          if (e.target.checked) next.add(c);
                          else next.delete(c);
                          setCaps(next);
                        }}
                        className="hidden"
                      />
                      <code className="font-mono">{c}</code>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          {err && <p className="text-[13px] text-danger">{err}</p>}
          <div className="flex justify-end pt-2 border-t border-border -mx-5 px-5 -mb-5 pb-5 mt-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save capabilities"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
