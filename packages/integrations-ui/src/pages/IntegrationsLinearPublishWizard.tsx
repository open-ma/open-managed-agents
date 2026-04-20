import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { A1FormStep, A1InstallLink } from "../api/types";

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
  /**
   * Loader for the user's existing agents — provided by Console because the
   * /v1/agents endpoint is owned by the main app, not this package.
   */
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

type Step = "pick" | "a1-credentials" | "a1-install" | "shared-redirect";

export function IntegrationsLinearPublishWizard({
  loadAgents,
  loadEnvironments,
}: PublishWizardProps) {
  const nav = useNavigate();
  const [search] = useSearchParams();
  const preselectedAgent = search.get("agent_id") ?? "";

  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [envs, setEnvs] = useState<EnvironmentOption[]>([]);
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [personaAvatar, setPersonaAvatar] = useState("");
  const [mode, setMode] = useState<"full" | "quick">("full");

  const [step, setStep] = useState<Step>("pick");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A1 wizard state
  const [a1Form, setA1Form] = useState<A1FormStep | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [a1InstallLink, setA1InstallLink] = useState<A1InstallLink | null>(null);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);

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

  // Default persona name to agent's name when selected.
  useEffect(() => {
    if (!personaName && agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents, personaName]);

  const returnUrl = `${window.location.origin}/integrations/linear`;

  async function startPublish() {
    if (!agentId || !envId || !personaName) {
      setError("Pick agent, environment, and persona name first");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      if (mode === "quick") {
        const r = await api.installShared({
          agentId,
          environmentId: envId,
          personaName,
          personaAvatarUrl: personaAvatar || null,
          returnUrl,
        });
        setStep("shared-redirect");
        // Navigate the browser to Linear OAuth.
        window.location.href = r.url;
      } else {
        const f = await api.startA1({
          agentId,
          environmentId: envId,
          personaName,
          personaAvatarUrl: personaAvatar || null,
          returnUrl,
        });
        setA1Form(f);
        setStep("a1-credentials");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  async function submitA1Credentials() {
    if (!a1Form || !clientId || !clientSecret) return;
    setError(null);
    setWorking(true);
    try {
      const link = await api.submitCredentials({
        formToken: a1Form.formToken,
        clientId,
        clientSecret,
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
      const r = await api.createHandoffLink(a1Form.formToken);
      setHandoffUrl(r.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="px-6 py-5 max-w-2xl">
      <Link to="/integrations/linear" className="text-sm text-blue-600 hover:underline">
        ← Linear integrations
      </Link>
      <h1 className="text-xl font-semibold mt-3 mb-1">Publish agent to Linear</h1>
      <p className="text-sm text-gray-500 mb-6">
        Make this agent a teammate in your Linear workspace.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
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
          mode={mode}
          setMode={setMode}
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
          working={working}
          onSubmit={submitA1Credentials}
          onHandoff={generateHandoffLink}
          handoffUrl={handoffUrl}
        />
      )}

      {step === "a1-install" && a1InstallLink && (
        <A1InstallStep link={a1InstallLink} />
      )}

      {step === "shared-redirect" && (
        <p className="text-sm text-gray-600">Redirecting to Linear…</p>
      )}
    </div>
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
  mode: "full" | "quick";
  setMode: (v: "full" | "quick") => void;
  working: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Agent">
        <select
          value={props.agentId}
          onChange={(e) => props.setAgentId(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        >
          <option value="">Pick an agent…</option>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Environment">
        <select
          value={props.envId}
          onChange={(e) => props.setEnvId(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        >
          <option value="">Pick an environment…</option>
          {props.envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Persona name (shown in Linear)">
        <input
          value={props.personaName}
          onChange={(e) => props.setPersonaName(e.target.value)}
          placeholder="e.g. Coder, Designer, Triage"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Avatar URL (optional)">
        <input
          value={props.personaAvatar}
          onChange={(e) => props.setPersonaAvatar(e.target.value)}
          placeholder="https://…"
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
        />
      </Field>

      <Field label="Identity mode">
        <div className="space-y-2">
          <ModeOption
            selected={props.mode === "full"}
            onSelect={() => props.setMode("full")}
            title="Full identity (recommended)"
            blurb="Agent becomes a real Linear teammate with @autocomplete and a slot in the assignee dropdown. Setup ~3 min, requires Linear admin."
          />
          <ModeOption
            selected={props.mode === "quick"}
            onSelect={() => props.setMode("quick")}
            title="Quick try (shared bot)"
            blurb="Posts as the shared OpenMA bot with a persona prefix. No admin needed. Limitations: no @autocomplete, single bot in dropdown."
          />
        </div>
      </Field>

      <div className="pt-2">
        <button
          onClick={props.onContinue}
          disabled={props.working}
          className="px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50"
        >
          {props.working ? "Working…" : "Continue →"}
        </button>
      </div>
    </div>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  blurb,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left p-3 border rounded ${
        selected ? "border-black bg-gray-50" : "border-gray-300 hover:border-gray-400"
      }`}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-gray-500 mt-1">{blurb}</div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
    </div>
  );
}

function A1CredentialsStep(props: {
  form: A1FormStep;
  clientId: string;
  setClientId: (v: string) => void;
  clientSecret: string;
  setClientSecret: (v: string) => void;
  working: boolean;
  onSubmit: () => void;
  onHandoff: () => void;
  handoffUrl: string | null;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-medium mb-2">1. Create a Linear app</h2>
        <p className="text-sm text-gray-600 mb-3">
          Open{" "}
          <a
            href="https://linear.app/settings/api"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            Linear → Settings → API
          </a>{" "}
          and create a new OAuth app with these values:
        </p>
        <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm space-y-2">
          <CopyRow label="App name" value={props.form.suggestedAppName} />
          <CopyRow label="Callback URL" value={props.form.callbackUrl} />
          <CopyRow label="Webhook URL" value={props.form.webhookUrl} />
          <CopyRow label="Webhook secret" value={props.form.webhookSecret} />
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Note: the Callback / Webhook URLs include <code>&lt;APP_ID&gt;</code> until we
          generate a real one — the URLs you see at step 3 will be the final values.
        </p>
      </div>

      <div>
        <h2 className="text-base font-medium mb-2">2. Paste credentials Linear gave you</h2>
        <Field label="Client ID">
          <input
            value={props.clientId}
            onChange={(e) => props.setClientId(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Client Secret">
          <input
            type="password"
            value={props.clientSecret}
            onChange={(e) => props.setClientSecret(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
        <div className="pt-2 flex items-center gap-3">
          <button
            onClick={props.onSubmit}
            disabled={props.working || !props.clientId || !props.clientSecret}
            className="px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50"
          >
            {props.working ? "Validating…" : "Continue →"}
          </button>
          <span className="text-xs text-gray-400">— or —</span>
          <button
            onClick={props.onHandoff}
            disabled={props.working}
            className="text-sm text-blue-600 hover:underline disabled:opacity-50"
          >
            Send setup link to your admin instead
          </button>
        </div>

        {props.handoffUrl && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm">
            <p className="font-medium mb-1">Send this link to your Linear admin:</p>
            <CopyRow label="Setup link" value={props.handoffUrl} />
            <p className="text-xs text-amber-800 mt-2">
              Anyone with this link can complete the install. Treat it as sensitive. Expires in
              7 days.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function A1InstallStep({ link }: { link: A1InstallLink }) {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-medium">3. Install the app in your workspace</h2>
      <p className="text-sm text-gray-600">
        We've validated your credentials. Click below to authorize the install in Linear —
        you'll be redirected back here automatically.
      </p>
      <a
        href={link.url}
        className="inline-block px-3 py-1.5 text-sm bg-black text-white rounded hover:bg-gray-800"
      >
        Install in Linear →
      </a>
      <details className="text-xs text-gray-500 mt-3">
        <summary className="cursor-pointer">Final URLs Linear should now show</summary>
        <div className="mt-2 space-y-1">
          <CopyRow label="Callback URL" value={link.callbackUrl} />
          <CopyRow label="Webhook URL" value={link.webhookUrl} />
        </div>
      </details>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  function copy() {
    void navigator.clipboard.writeText(value);
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-28 shrink-0">{label}</span>
      <code className="flex-1 text-xs bg-white border border-gray-200 rounded px-2 py-1 truncate">
        {value}
      </code>
      <button
        onClick={copy}
        className="text-xs text-blue-600 hover:underline shrink-0"
      >
        Copy
      </button>
    </div>
  );
}
