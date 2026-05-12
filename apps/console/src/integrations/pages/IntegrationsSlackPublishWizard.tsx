import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { A1FormStep, A1InstallLink } from "../api/types";
import { SecretInput, TextInput } from "../../components/Input";
import { Combobox } from "../../components/Combobox";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
}

interface PublishWizardProps {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "a1-credentials" | "a1-install";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "pick", label: "Configure" },
  { id: "a1-credentials", label: "Credentials" },
  { id: "a1-install", label: "Install" },
];

export function IntegrationsSlackPublishWizard({
  loadAgents,
  loadEnvironments,
}: PublishWizardProps) {
  const [search] = useSearchParams();
  const preselectedAgent = search.get("agent_id") ?? "";

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [envs, setEnvs] = useState<EnvironmentOption[]>([]);
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [personaAvatar, setPersonaAvatar] = useState("");

  const [step, setStep] = useState<Step>("pick");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [a1Form, setA1Form] = useState<A1FormStep | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [a1InstallLink, setA1InstallLink] = useState<A1InstallLink | null>(null);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  const [handoffCopied, setHandoffCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [a, e] = await Promise.all([loadAgents(), loadEnvironments()]);
        setAgents(a);
        setEnvs(e);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [loadAgents, loadEnvironments]);

  useEffect(() => {
    if (!personaName && agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents, personaName]);

  const returnUrl = `${window.location.origin}/integrations/slack`;

  async function startPublish() {
    if (!agentId || !envId || !personaName) {
      setError("Pick agent, environment, and persona name first");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      const f = await api.slack.startA1({
        agentId,
        environmentId: envId,
        personaName,
        personaAvatarUrl: personaAvatar || null,
        returnUrl,
      });
      setA1Form(f);
      setStep("a1-credentials");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitA1Credentials() {
    if (!a1Form || !clientId || !clientSecret || !signingSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.slack.submitCredentials({
        formToken: a1Form.formToken,
        clientId,
        clientSecret,
        signingSecret,
      });
      setA1InstallLink(link);
      setStep("a1-install");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function generateHandoffLink() {
    if (!a1Form) return;
    setError(null);
    setWorking(true);
    try {
      const r = await api.slack.createHandoffLink(a1Form.formToken);
      setHandoffUrl(r.url);
      // Auto-copy so the user doesn't have to chase the row. Clipboard can
      // throw if the page isn't focused or the browser blocks it; treat the
      // failure as "user can still copy manually" and surface a quiet hint.
      try {
        await navigator.clipboard.writeText(r.url);
        setHandoffCopied(true);
      } catch {
        setHandoffCopied(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 lg:px-10 py-8 lg:py-10">
        <Link
          to="/integrations/slack"
          className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-brand transition-colors"
        >
          ← Slack integrations
        </Link>

        <header className="mt-3 mb-6">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Publish agent to Slack
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">
            Make this agent a teammate in your Slack workspace.
          </p>
        </header>

        <StepIndicator current={step} />

        {error && (
          <div className="mb-4 rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}

        {step === "pick" && (
          <PickStep
            agents={agents}
            envs={envs}
            agentId={agentId}
            setAgentId={setAgentId}
            envId={envId}
            setEnvId={setEnvId}
            personaName={personaName}
            setPersonaName={setPersonaName}
            personaAvatar={personaAvatar}
            setPersonaAvatar={setPersonaAvatar}
            working={working}
            onContinue={startPublish}
          />
        )}

        {step === "a1-credentials" && a1Form && (
          <A1CredentialsStep
            form={a1Form}
            clientId={clientId}
            setClientId={setClientId}
            clientSecret={clientSecret}
            setClientSecret={setClientSecret}
            signingSecret={signingSecret}
            setSigningSecret={setSigningSecret}
            working={working}
            onSubmit={submitA1Credentials}
            onHandoff={generateHandoffLink}
            handoffUrl={handoffUrl}
            handoffCopied={handoffCopied}
            onBack={() => setStep("pick")}
          />
        )}

        {step === "a1-install" && a1InstallLink && (
          <A1InstallStep link={a1InstallLink} onBack={() => setStep("a1-credentials")} />
        )}
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-2 mb-7" aria-label="Wizard progress">
      {STEPS.map((s, i) => {
        const state =
          i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
        return (
          <li key={s.id} className="flex items-center gap-2 flex-1 last:flex-none">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-mono font-medium shrink-0 ${
                  state === "done"
                    ? "bg-brand text-brand-fg"
                    : state === "current"
                      ? "bg-brand-subtle text-brand border border-brand"
                      : "bg-bg-surface text-fg-subtle border border-border"
                }`}
              >
                {state === "done" ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </div>
              <span
                className={`text-[12px] font-medium uppercase tracking-wider truncate ${
                  state === "current"
                    ? "text-fg"
                    : state === "done"
                      ? "text-fg-muted"
                      : "text-fg-subtle"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-px ${
                  i < currentIdx ? "bg-brand/40" : "bg-border"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PickStep(props: {
  agents: AgentOption[];
  envs: EnvironmentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  envId: string;
  setEnvId: (v: string) => void;
  personaName: string;
  setPersonaName: (v: string) => void;
  personaAvatar: string;
  setPersonaAvatar: (v: string) => void;
  working: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Agent">
          <Combobox<{ id: string; name: string }>
            value={props.agentId}
            onValueChange={(v) => props.setAgentId(v)}
            endpoint="/v1/agents"
            getValue={(a) => a.id}
            getLabel={(a) => a.name}
            getTextLabel={(a) => a.name}
            placeholder="Pick an agent…"
          />
        </Field>

        <Field label="Environment">
          <Combobox<{ id: string; name: string }>
            value={props.envId}
            onValueChange={(v) => props.setEnvId(v)}
            endpoint="/v1/environments"
            getValue={(e) => e.id}
            getLabel={(e) => e.name}
            getTextLabel={(e) => e.name}
            placeholder="Pick an environment…"
          />
        </Field>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Persona name (shown in Slack)">
          <TextInput
            value={props.personaName}
            onChange={(e) => props.setPersonaName(e.target.value)}
            placeholder="e.g. Coder, Designer, Triage"
            className={inputCls}
          />
        </Field>

        <Field label="Avatar URL (optional)">
          <TextInput
            value={props.personaAvatar}
            onChange={(e) => props.setPersonaAvatar(e.target.value)}
            placeholder="https://…"
            className={inputCls}
          />
        </Field>
      </div>

      <div className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-3 text-[12px] text-fg-muted">
        Your agent becomes a real Slack teammate — @-mentionable, replies in threads,
        joins DMs. Setup ~3 min, requires Slack admin (or send a setup link).
      </div>

      <div className="pt-1">
        <button
          onClick={props.onContinue}
          disabled={props.working}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {props.working ? "Working…" : "Continue"}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  );
}

function A1CredentialsStep(props: {
  form: A1FormStep;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  signingSecret: string;
  setSigningSecret: (v: string) => void;
  working: boolean;
  onSubmit: () => void;
  onHandoff: () => void;
  handoffUrl: string | null;
  handoffCopied: boolean;
  onBack: () => void;
}) {
  const manifestUrl = props.form.manifestLaunchUrl;
  return (
    <div className="space-y-7">
      {manifestUrl && (
        <section className="rounded-md border border-brand/30 bg-brand-subtle/30 p-4">
          <h2 className="text-[15px] font-medium text-fg mb-1">
            One-click setup
          </h2>
          <p className="text-[13px] text-fg-muted mb-3">
            Let Slack pre-configure the App for you — name, scopes, events, and
            redirect URLs come from a manifest we ship. You'll just confirm in
            Slack, then come back here to paste 3 secrets.
          </p>
          <a
            href={manifestUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors"
          >
            Create Slack App
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
          </a>
          <p className="text-[12px] text-fg-subtle mt-2">
            Opens api.slack.com in a new tab. After Slack creates the App, copy
            <strong> Client ID</strong>, <strong>Client Secret</strong>, and
            <strong> Signing Secret</strong> from the App's <em>Basic Information</em>
            page and paste them below.
          </p>
        </section>
      )}

      <details className="rounded-md border border-border bg-bg-surface/30 px-3.5 py-2" open={!manifestUrl}>
        <summary className="text-[13px] font-medium text-fg cursor-pointer py-1.5">
          {manifestUrl ? "Or set up the App manually" : "Create a Slack App manually"}
        </summary>
        <div className="pt-3 pb-1.5">
          <p className="text-[13px] text-fg-muted mb-3">
            Open{" "}
            <a
              href="https://api.slack.com/apps"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              api.slack.com → Your Apps
            </a>{" "}
            → Create New App → From scratch. Name it and pick your workspace.
            Then plug these URLs into the App settings:
          </p>
          <div className="rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
            <CopyRow label="App name" value={props.form.suggestedAppName} />
            <CopyRow label="Redirect URL" value={props.form.callbackUrl} />
            <CopyRow label="Events Request URL" value={props.form.webhookUrl} />
          </div>
          <p className="text-[12px] text-fg-subtle mt-2">
            Paste the Redirect URL under <strong>OAuth &amp; Permissions</strong>; paste the
            Events Request URL under <strong>Event Subscriptions</strong> and wait for
            the green "Verified" check (Slack hits the URL with a signed handshake).
            Subscribe to bot events: <code>app_mention</code>,{" "}
            <code>message.channels</code>, <code>message.im</code>,{" "}
            <code>message.groups</code>, <code>message.mpim</code>,{" "}
            <code>tokens_revoked</code>, <code>app_uninstalled</code>.
          </p>
        </div>
      </details>

      <section>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Paste credentials Slack gave you
        </h2>
        <p className="text-[13px] text-fg-muted mb-3">
          From your Slack App's <strong>Basic Information</strong> page. The Signing
          Secret signs all incoming webhooks; we verify every event with it.
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Client ID">
            <TextInput
              value={props.clientId}
              onChange={(e) => props.setClientId(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Client Secret">
            <SecretInput
              value={props.clientSecret}
              onChange={(e) => props.setClientSecret(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Signing Secret">
            <SecretInput
              value={props.signingSecret}
              onChange={(e) => props.setSigningSecret(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={props.onBack}
            disabled={props.working}
            className="text-[13px] text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
          >
            ← Back
          </button>
          <button
            onClick={props.onSubmit}
            disabled={props.working || !props.clientId || !props.clientSecret || !props.signingSecret}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {props.working ? "Validating…" : "Continue"}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
          <span className="text-[12px] text-fg-subtle">or</span>
          <button
            onClick={props.onHandoff}
            disabled={props.working}
            className="text-[13px] text-fg-muted hover:text-brand transition-colors disabled:opacity-50"
          >
            Send setup link to your admin →
          </button>
        </div>

        {props.handoffUrl && (
          <div className="mt-4 rounded-md border border-warning/30 bg-warning-subtle p-3.5">
            <div className="flex items-start gap-2 mb-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-warning shrink-0 mt-0.5">
                <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
              <div className="text-[13px] font-medium text-fg">
                Send this link to your Slack admin
                {props.handoffCopied && (
                  <span className="ml-2 text-[12px] font-normal text-success">
                    ✓ Copied to clipboard
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-md border border-warning/30 bg-bg">
              <CopyRow label="Setup link" value={props.handoffUrl} />
            </div>
            <p className="text-[12px] text-fg-muted mt-2">
              Anyone with this link can complete the install. Treat it as sensitive.
              Expires in 7 days.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function A1InstallStep({ link, onBack }: { link: A1InstallLink; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[15px] font-medium text-fg mb-1.5">
          Install the app in your workspace
        </h2>
        <p className="text-[13px] text-fg-muted">
          We've validated your credentials. Click below to authorize the install in
          Slack — you'll be redirected back here automatically.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="text-[13px] text-fg-muted hover:text-fg transition-colors"
        >
          ← Back
        </button>
        <a
          href={link.url}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[13px] bg-brand text-brand-fg rounded-md font-medium hover:bg-brand-hover transition-colors"
        >
          Install in Slack
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
        </a>
      </div>

      <details className="text-[12px] text-fg-muted mt-3">
        <summary className="cursor-pointer hover:text-fg transition-colors">
          Verify the URLs Slack should now show
        </summary>
        <div className="mt-2 rounded-md border border-border bg-bg-surface/30 divide-y divide-border">
          <CopyRow label="Redirect URL" value={link.callbackUrl} />
          <CopyRow label="Events Request URL" value={link.webhookUrl} />
        </div>
      </details>
    </div>
  );
}

function CopyRow({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(!secret);
  function copy() {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const display = secret && !reveal ? "•".repeat(Math.min(value.length, 28)) : value;
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className="text-[11px] text-fg-muted font-mono uppercase tracking-wider w-28 shrink-0">
        {label}
      </span>
      <code className="flex-1 text-[12px] font-mono text-fg truncate select-all">
        {display}
      </code>
      <div className="flex items-center gap-1 shrink-0">
        {secret && (
          <button
            onClick={() => setReveal((r) => !r)}
            className="text-[11px] text-fg-muted hover:text-fg transition-colors px-1.5 py-0.5 rounded"
            title={reveal ? "Hide" : "Reveal"}
          >
            {reveal ? "Hide" : "Show"}
          </button>
        )}
        <button
          onClick={copy}
          className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
            copied
              ? "text-success bg-success-subtle"
              : "text-fg-muted hover:text-fg hover:bg-bg-surface"
          }`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

const selectCls = inputCls;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-fg-muted mb-1.5">{label}</label>
      {children}
    </div>
  );
}
