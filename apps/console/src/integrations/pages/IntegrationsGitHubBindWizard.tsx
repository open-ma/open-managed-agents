import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { GitHubA1FormStep, GitHubA1InstallLink } from "../api/types";

const api = new IntegrationsApi();

interface Agent { id: string; name: string }
interface Environment { id: string; name: string }

interface Props {
  loadAgents: () => Promise<Agent[]>;
  loadEnvironments: () => Promise<Environment[]>;
}

type Phase = "config" | "registering" | "installing" | "done" | "error";

/**
 * Three-screen wizard with the manifest flow as default. Cuts the manual
 * 5-min "register App, download .pem, paste back 4 secrets" path down to
 * one button + one install click.
 *
 * Phases:
 *   config       → user picks agent + env + persona + clicks "Bind"
 *                  We POST start-a1, get formToken + manifestStartUrl.
 *   registering  → we open manifestStartUrl in a popup. User confirms on
 *                  GitHub. GitHub redirects through our gateway which
 *                  exchanges the manifest code and writes the App row.
 *                  Meanwhile we poll listInstallations() until we see
 *                  the new appOmaId show up as a publication shell.
 *   installing   → we open the install URL (returned from manifest
 *                  callback) in a popup. User picks org and confirms
 *                  install. Gateway completes install_callback. We poll
 *                  until publication.status === "live".
 *   done         → success. Show confetti-equivalent and a link to the
 *                  workspace page.
 */
export function IntegrationsGitHubBindWizard({ loadAgents, loadEnvironments }: Props) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [envId, setEnvId] = useState<string>("");
  const [persona, setPersona] = useState<string>("");

  const [phase, setPhase] = useState<Phase>("config");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<GitHubA1FormStep | null>(null);
  const [installLink] = useState<GitHubA1InstallLink | null>(null);
  const [livePubId, setLivePubId] = useState<string | null>(null);

  // Background poll handle. Single source of truth so cleanup-on-unmount and
  // cleanup-on-success can both reach in and stop it without leaking.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // If GitHub completed install and bounced back to /integrations/github with
  // ?install=ok&publication_id=…, surface a "done" state directly.
  useEffect(() => {
    const installFlag = searchParams.get("install");
    const pubId = searchParams.get("publication_id");
    if (installFlag === "ok" && pubId) {
      setPhase("done");
      setLivePubId(pubId);
    }
  }, [searchParams]);

  useEffect(() => {
    void loadAgents().then(setAgents);
    void loadEnvironments().then(setEnvironments);
  }, [loadAgents, loadEnvironments]);

  // Default persona name to the chosen agent's name.
  useEffect(() => {
    if (!persona && agentId) {
      const a = agents.find((x) => x.id === agentId);
      if (a) setPersona(a.name);
    }
  }, [agentId, agents, persona]);

  // Tear down any in-flight poll on unmount. Without this, navigating away
  // mid-flow leaves a setInterval firing fetches against a dead component.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startBind() {
    if (!agentId || !envId || !persona) {
      setError("Pick an agent, environment, and persona name.");
      return;
    }
    setError(null);
    setPhase("registering");
    try {
      const r = await api.github.startA1({
        agentId,
        environmentId: envId,
        personaName: persona,
        returnUrl: `${window.location.origin}/integrations/github`,
      });
      setForm(r);
      // Open manifest flow in a popup. The popup will eventually navigate
      // to our gateway callback, which auto-redirects to GitHub install.
      if (r.manifestStartUrl) {
        window.open(r.manifestStartUrl, "github-bind", "width=820,height=720");
      }
      // Optimistically advance to "installing" — once the user's clicked
      // through the manifest flow, GitHub takes them straight into the
      // install screen. The poll below covers both phases until a live
      // publication appears.
      setPhase("installing");
      startInstallPoll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  // Poll every 5 seconds for a live publication owned by this agent. When we
  // find one, switch to "done" and stop. Hard cap at ~5 minutes (60 ticks)
  // so abandoned tabs don't poll forever.
  function startInstallPoll() {
    stopPolling();
    let ticks = 0;
    const TICK_MS = 5_000;
    const MAX_TICKS = 60;
    pollRef.current = setInterval(async () => {
      ticks += 1;
      if (ticks > MAX_TICKS) {
        stopPolling();
        return;
      }
      try {
        const all = await api.github.listInstallations();
        for (const inst of all) {
          const pubs = await api.github.listPublications(inst.id);
          const live = pubs.find(
            (p) => p.agent_id === agentId && p.status === "live",
          );
          if (live) {
            stopPolling();
            setPhase("done");
            setLivePubId(live.id);
            return;
          }
        }
      } catch {
        // Network blip — keep polling. We only stop on success or timeout.
      }
    }, TICK_MS);
  }

  // Manual refresh button — same lookup as the poll, runs once.
  async function refresh() {
    if (!form) return;
    try {
      const all = await api.github.listInstallations();
      for (const inst of all) {
        const pubs = await api.github.listPublications(inst.id);
        const live = pubs.find(
          (p) => p.agent_id === agentId && p.status === "live",
        );
        if (live) {
          stopPolling();
          setPhase("done");
          setLivePubId(live.id);
          return;
        }
      }
    } catch {
      // ignore — user can keep waiting
    }
  }

  // ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[680px] mx-auto px-8 lg:px-10 py-10 lg:py-12">
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg mb-2">
          Bind agent to GitHub
        </h1>
        <p className="text-[14px] text-fg-muted mb-8">
          Make this agent a GitHub teammate — assignable, mentionable, request-as-reviewer.
          The agent gets its own bot identity (a GitHub App) and its own audit trail.
        </p>

        <Stepper phase={phase} />

        {phase === "config" && (
          <ConfigForm
            agents={agents}
            environments={environments}
            agentId={agentId}
            envId={envId}
            persona={persona}
            onAgent={setAgentId}
            onEnv={setEnvId}
            onPersona={setPersona}
            onSubmit={startBind}
            error={error}
          />
        )}

        {(phase === "registering" || phase === "installing") && form && (
          <InProgress
            phase={phase}
            personaName={form.suggestedAppName}
            manifestUrl={form.manifestStartUrl ?? null}
            installUrl={installLink?.url ?? null}
            onRefresh={refresh}
          />
        )}

        {phase === "done" && (
          <Done
            livePubId={livePubId}
            onView={() => navigate("/integrations/github")}
          />
        )}

        {phase === "error" && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
            {error}
            <button
              onClick={() => { setPhase("config"); setError(null); }}
              className="ml-3 underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface Step {
  key: Phase;
  label: string;
  /** One-line subtitle explaining what happens during this step. */
  hint: string;
}

function Stepper({ phase }: { phase: Phase }) {
  // Plain operational labels; subtitles do the explaining. Tried "Saddle
  // up / Mint App / Install / Riding" as a brand wink — landed too cute
  // for an enterprise install flow, so kept the verbs functional and
  // saved the warmth for the subtitle copy.
  const steps: Step[] = [
    { key: "config", label: "Configure", hint: "Pick agent, env, bot name" },
    { key: "registering", label: "Register", hint: "GitHub mints a new App" },
    { key: "installing", label: "Install", hint: "Grant access to your org" },
    { key: "done", label: "Live", hint: "Bot is responding to events" },
  ];
  const idx = steps.findIndex((s) => s.key === phase);
  return (
    <ol className="flex items-stretch gap-1 mb-8 text-[12px]">
      {steps.map((s, i) => {
        const state = i < idx ? "done" : i === idx ? "active" : "pending";
        return (
          <li key={s.key} className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`w-5 h-5 shrink-0 rounded-full inline-flex items-center justify-center text-[11px] font-medium ${
                  state === "done"
                    ? "bg-success text-bg"
                    : state === "active"
                    ? "bg-brand text-brand-fg"
                    : "bg-bg-surface text-fg-muted"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span
                className={`text-[12px] truncate ${
                  state === "active"
                    ? "text-fg font-medium"
                    : state === "done"
                    ? "text-fg-muted"
                    : "text-fg-subtle"
                }`}
              >
                {s.label}
              </span>
            </div>
            <p
              className={`mt-1 ml-7 text-[11px] truncate ${
                state === "active" ? "text-fg-muted" : "text-fg-subtle"
              }`}
            >
              {s.hint}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function ConfigForm({
  agents, environments, agentId, envId, persona,
  onAgent, onEnv, onPersona, onSubmit, error,
}: {
  agents: Agent[];
  environments: Environment[];
  agentId: string;
  envId: string;
  persona: string;
  onAgent: (v: string) => void;
  onEnv: (v: string) => void;
  onPersona: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-5">
      <Field label="Agent">
        <select
          value={agentId}
          onChange={(e) => onAgent(e.target.value)}
          className="w-full px-3 py-2 border border-border rounded-md bg-bg text-[14px]"
          required
        >
          <option value="">Pick an agent…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field label="Environment">
        <select
          value={envId}
          onChange={(e) => onEnv(e.target.value)}
          className="w-full px-3 py-2 border border-border rounded-md bg-bg text-[14px]"
          required
        >
          <option value="">Pick an environment…</option>
          {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </Field>
      <Field
        label="Bot name (visible in GitHub)"
        hint="GitHub will create a bot user @<slug>[bot] from this name. Defaults to the agent's name."
      >
        <input
          type="text"
          value={persona}
          onChange={(e) => onPersona(e.target.value)}
          placeholder="e.g. Coder"
          className="w-full px-3 py-2 border border-border rounded-md bg-bg text-[14px]"
          required
        />
      </Field>

      {error && (
        <p className="text-[13px] text-danger">{error}</p>
      )}

      <div className="flex items-center justify-between gap-4 pt-1">
        <p className="text-[12px] text-fg-muted leading-snug">
          Opens a popup to GitHub. You'll click <strong>Create GitHub App</strong>
          {" "}and then <strong>Install</strong> on the org you want this bot to
          work in.
        </p>
        <button
          type="submit"
          className="shrink-0 px-5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors"
        >
          Bind on GitHub
        </button>
      </div>
    </form>
  );
}

function InProgress({
  phase,
  personaName,
  manifestUrl,
  installUrl,
  onRefresh,
}: {
  phase: Phase;
  personaName: string;
  manifestUrl: string | null;
  installUrl: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="border border-border rounded-lg p-6 bg-bg-surface/30 text-center">
      <div className="text-[15px] font-medium text-fg mb-2">
        {phase === "registering"
          ? `Creating "${personaName}" on GitHub…`
          : `Installing on your org…`}
      </div>
      <p className="text-[13px] text-fg-muted mb-5">
        Switch to the GitHub popup to confirm. We'll check every few seconds
        and pick up the new install automatically — no need to refresh.
      </p>

      <div className="flex flex-col gap-2 items-center">
        {phase === "registering" && manifestUrl && (
          <a
            href={manifestUrl}
            target="github-bind"
            className="text-[13px] text-brand hover:underline"
          >
            Re-open GitHub registration popup →
          </a>
        )}
        {phase === "installing" && installUrl && (
          <a
            href={installUrl}
            target="github-bind"
            className="text-[13px] text-brand hover:underline"
          >
            Re-open GitHub install popup →
          </a>
        )}
        <button
          onClick={onRefresh}
          className="text-[12px] text-fg-muted hover:text-brand transition-colors mt-3"
        >
          Check now
        </button>
      </div>
    </div>
  );
}

function Done({ livePubId, onView }: { livePubId: string | null; onView: () => void }) {
  return (
    <div className="border border-success/30 bg-success-subtle rounded-lg p-6 text-center">
      <div className="text-success text-[15px] font-medium mb-2">✓ Bot is live on GitHub</div>
      <p className="text-[13px] text-fg-muted mb-4">
        Try assigning a GitHub issue to the bot or @-mentioning it in a comment — should respond in seconds.
        First response after binding may take ~5 seconds (cold start).
      </p>
      <button
        onClick={onView}
        className="px-4 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover"
      >
        View installation
      </button>
      {livePubId && (
        <p className="mt-3 text-[11px] font-mono text-fg-subtle">publication: {livePubId}</p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-fg mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-fg-muted">{hint}</p>}
    </div>
  );
}
