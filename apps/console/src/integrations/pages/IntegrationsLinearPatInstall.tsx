import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { IntegrationsApi } from "../api/client";
import { SecretInput, TextInput } from "../../components/Input";

const api = new IntegrationsApi();

interface AgentOption {
  id: string;
  name: string;
}

interface EnvironmentOption {
  id: string;
  name: string;
}

interface Props {
  loadAgents: () => Promise<AgentOption[]>;
  loadEnvironments: () => Promise<EnvironmentOption[]>;
}

/**
 * Install Linear via Personal API Key — Symphony-equivalent: paste PAT,
 * pick agent + environment, done. No OAuth dance, no Linear OAuth app to
 * register.
 *
 * Tradeoffs vs A1 OAuth-app install:
 *   - bot identity is the PAT owner (their face on every comment)
 *   - no AgentSession panel UX (Linear can't open a panel for a non-app user)
 *   - cron-driven autopilot only — no realtime webhook trigger
 * For a single-user setup or small private workspace this is the fast path.
 */
export function IntegrationsLinearPatInstall({ loadAgents, loadEnvironments }: Props) {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [envs, setEnvs] = useState<EnvironmentOption[]>([]);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [pat, setPat] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Default persona to the agent's name if still empty.
  useEffect(() => {
    if (!personaName && agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (agent) setPersonaName(agent.name);
    }
  }, [agentId, agents, personaName]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!agentId || !envId || !personaName.trim() || !pat.trim()) {
      setError("All fields required");
      return;
    }
    setWorking(true);
    try {
      const res = await api.installPersonalToken({
        agentId,
        environmentId: envId,
        personaName: personaName.trim(),
        personaAvatarUrl: null,
        patToken: pat.trim(),
      });
      // Navigate to the publication detail (workspace page) so user can
      // immediately configure dispatch rules.
      navigate(`/integrations/linear`);
      void res.publicationId;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-8 lg:px-10 py-10 lg:py-12">
        <header className="mb-8">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Install Linear via Personal API Key
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
            Paste a Linear PAT, pick the agent + environment to bind. Bot
            actions in Linear will be attributed to the PAT owner. For full
            agent identity (panel UX, dedicated bot user), use{" "}
            <a className="text-accent underline" href="/integrations/linear/publish">
              Publish agent
            </a>{" "}
            instead.
          </p>
        </header>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-md border border-red-500/40 bg-red-500/10 text-[13px] text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5" autoComplete="off">
          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">Agent</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-border bg-bg text-[14px]"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              <option value="">— pick an agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">Environment</label>
            <select
              className="w-full px-3 py-2 rounded-md border border-border bg-bg text-[14px]"
              value={envId}
              onChange={(e) => setEnvId(e.target.value)}
            >
              <option value="">— pick an environment —</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">
              Persona display name
            </label>
            <TextInput
              className="w-full px-3 py-2 rounded-md border border-border bg-bg text-[14px]"
              placeholder="e.g. Coder"
              value={personaName}
              onChange={(e) => setPersonaName(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">
              Linear Personal API Key
            </label>
            <SecretInput
              className="w-full px-3 py-2 rounded-md border border-border bg-bg text-[14px] font-mono"
              placeholder="lin_api_…"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
            <p className="mt-1 text-[12px] text-fg-muted">
              Generate at Linear → Settings → Security &amp; access → Personal API keys.
              Stored encrypted in your tenant vault; not shared with agents directly.
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={working}
              className="px-4 py-2 rounded-md bg-accent text-accent-fg text-[14px] font-medium disabled:opacity-50"
            >
              {working ? "Installing…" : "Install"}
            </button>
            <a
              href="/integrations/linear"
              className="px-4 py-2 text-[14px] text-fg-muted hover:text-fg"
            >
              Cancel
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}
