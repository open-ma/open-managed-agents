import { useState } from "react";
import { useNavigate } from "react-router";
import { AGENT_TEMPLATES } from "../data/templates";
import { useApi } from "../lib/api";

/* ── Step definitions ── */
const STEPS = [
  { id: "agent", label: "1. Create agent", description: "Define your agent's capabilities" },
  { id: "env", label: "2. Get an environment", description: "Set up a sandbox for execution" },
  { id: "session", label: "3. Start session", description: "Begin a conversation" },
  { id: "integrate", label: "4. Integrate", description: "Connect via API or SDK" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export function Dashboard() {
  const nav = useNavigate();
  const { api } = useApi();
  const [step, setStep] = useState<StepId>("agent");
  const [templateSearch, setTemplateSearch] = useState("");
  const [describeText, setDescribeText] = useState("");
  const [generating, setGenerating] = useState(false);

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.tags.some((tag) => tag.toLowerCase().includes(templateSearch.toLowerCase())),
      )
    : AGENT_TEMPLATES;

  const handleGenerate = async () => {
    if (!describeText.trim()) return;
    setGenerating(true);
    try {
      const agent = await api<{ id: string }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify({
          name: describeText.slice(0, 40),
          model: "claude-sonnet-4-6",
          system: describeText,
          tools: [{ type: "agent_toolset_20260401" }],
        }),
      });
      nav(`/agents/${agent.id}`);
    } catch {
      // fallback: navigate to agents page to create manually
      nav("/agents");
    }
    setGenerating(false);
  };

  const handleTemplateClick = async (tmpl: (typeof AGENT_TEMPLATES)[number]) => {
    if (tmpl.id === "blank") {
      nav("/agents");
      return;
    }
    try {
      const payload: Record<string, unknown> = {
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        tools: [{ type: "agent_toolset_20260401" }],
      };
      if (tmpl.mcpServers.length) payload.mcp_servers = tmpl.mcpServers;
      if (tmpl.skills.length) payload.skills = tmpl.skills;
      const agent = await api<{ id: string }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      nav(`/agents/${agent.id}`);
    } catch {
      nav("/agents");
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <h1 className="font-display text-xl font-semibold tracking-tight text-fg mb-1">
        Quickstart
      </h1>
      <p className="text-fg-muted text-sm mb-6">Get up and running with managed agents in minutes.</p>

      {/* Step tabs */}
      <div className="flex border-b border-border mb-6">
        {STEPS.map((s) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              step === s.id
                ? "border-brand text-brand"
                : "border-transparent text-fg-muted hover:text-fg hover:border-border-strong"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Step content */}
      {step === "agent" && (
        <div className="space-y-6">
          {/* Describe your agent */}
          <div className="border border-border rounded-lg p-5 bg-bg">
            <h3 className="font-medium text-fg mb-2">Describe your agent</h3>
            <p className="text-sm text-fg-muted mb-3">
              Describe what you want your agent to do, and we'll generate a configuration for you.
            </p>
            <div className="flex gap-2">
              <input
                value={describeText}
                onChange={(e) => setDescribeText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
                className="flex-1 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle"
                placeholder="e.g. A research agent that finds and summarizes academic papers..."
              />
              <button
                onClick={handleGenerate}
                disabled={!describeText.trim() || generating}
                className="px-4 py-2 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {generating ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>

          {/* Browse templates */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-fg">Or start from a template</h3>
              <input
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                className="border border-border rounded-md px-3 py-1.5 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle w-56"
                placeholder="Search templates..."
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredTemplates.map((tmpl) => (
                <button
                  key={tmpl.id}
                  onClick={() => handleTemplateClick(tmpl)}
                  className="text-left border border-border rounded-lg p-4 hover:border-brand hover:bg-bg-surface transition-all"
                >
                  <div className="font-medium text-sm text-fg">{tmpl.name}</div>
                  <div className="text-xs text-fg-muted mt-1 line-clamp-2">{tmpl.description}</div>
                  {tmpl.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tmpl.tags.map((tag) => (
                        <span key={tag} className="px-1.5 py-0.5 bg-bg-surface text-fg-muted rounded text-[10px]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))}
            </div>
            {filteredTemplates.length === 0 && (
              <div className="text-center py-8 text-fg-subtle text-sm">No templates match your search.</div>
            )}
          </div>
        </div>
      )}

      {step === "env" && (
        <div className="max-w-2xl space-y-4">
          <p className="text-fg-muted text-sm">
            Environments provide isolated sandboxes for agent code execution. Create one to get started.
          </p>
          <div className="border border-border rounded-lg p-5 bg-bg space-y-3">
            <h3 className="font-medium text-fg">Create an environment</h3>
            <pre className="bg-bg-surface rounded-lg p-4 text-sm overflow-x-auto font-mono text-fg-muted leading-relaxed">{`curl /v1/environments -H "x-api-key: $KEY" \\
  -H "content-type: application/json" \\
  -d '{"name":"dev","config":{"type":"cloud"}}'`}</pre>
            <button onClick={() => nav("/environments")} className="text-sm text-brand hover:underline">
              Or create in the console →
            </button>
          </div>
        </div>
      )}

      {step === "session" && (
        <div className="max-w-2xl space-y-4">
          <p className="text-fg-muted text-sm">
            Sessions are conversations between you and an agent. Each session runs in an environment.
          </p>
          <div className="border border-border rounded-lg p-5 bg-bg space-y-3">
            <h3 className="font-medium text-fg">Start a session</h3>
            <pre className="bg-bg-surface rounded-lg p-4 text-sm overflow-x-auto font-mono text-fg-muted leading-relaxed">{`# Create a session
curl /v1/sessions -H "x-api-key: $KEY" \\
  -H "content-type: application/json" \\
  -d '{"agent":"$AGENT_ID","environment_id":"$ENV_ID"}'

# Send a message
curl /v1/sessions/$SID/events -H "x-api-key: $KEY" \\
  -H "content-type: application/json" \\
  -d '{"events":[{"type":"user.message",
    "content":[{"type":"text","text":"Hello!"}]}]}'`}</pre>
            <button onClick={() => nav("/sessions")} className="text-sm text-brand hover:underline">
              Or create in the console →
            </button>
          </div>
        </div>
      )}

      {step === "integrate" && (
        <div className="max-w-2xl space-y-4">
          <p className="text-fg-muted text-sm">
            Use the Anthropic SDK or REST API to integrate managed agents into your application.
          </p>
          <div className="border border-border rounded-lg p-5 bg-bg space-y-3">
            <h3 className="font-medium text-fg">Python SDK</h3>
            <pre className="bg-bg-surface rounded-lg p-4 text-sm overflow-x-auto font-mono text-fg-muted leading-relaxed">{`import anthropic

client = anthropic.Anthropic(
    api_key="$KEY",
    base_url="https://your-deployment.workers.dev"
)

# Create and run a session
session = client.beta.managed_agents.sessions.create(
    agent="$AGENT_ID",
    environment_id="$ENV_ID",
)

response = client.beta.managed_agents.sessions.events.create(
    session_id=session.id,
    events=[{
        "type": "user.message",
        "content": [{"type": "text", "text": "Hello!"}]
    }]
)`}</pre>
          </div>
          <div className="border border-border rounded-lg p-5 bg-bg space-y-3">
            <h3 className="font-medium text-fg">TypeScript SDK</h3>
            <pre className="bg-bg-surface rounded-lg p-4 text-sm overflow-x-auto font-mono text-fg-muted leading-relaxed">{`import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "$KEY",
  baseURL: "https://your-deployment.workers.dev"
});

const session = await client.beta.managedAgents.sessions.create({
  agent: "$AGENT_ID",
  environment_id: "$ENV_ID",
});

const response = await client.beta.managedAgents.sessions.events.create(
  session.id,
  { events: [{ type: "user.message",
    content: [{ type: "text", text: "Hello!" }] }] }
);`}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
