import { useState, useEffect, useCallback } from "react";
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
  const [selectedTemplate, setSelectedTemplate] = useState<(typeof AGENT_TEMPLATES)[number] | null>(null);
  const [creating, setCreating] = useState(false);
  const [connectedServers, setConnectedServers] = useState<Set<string>>(new Set());
  const [connectingServer, setConnectingServer] = useState<string | null>(null);

  // Listen for OAuth popup completion
  const handleOAuthMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === "oauth_complete" && event.data.service) {
      setConnectedServers((prev) => new Set([...prev, event.data.service]));
      setConnectingServer(null);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [handleOAuthMessage]);

  const handleConnect = async (mcpServerUrl: string, serverName: string) => {
    setConnectingServer(serverName);
    // Create a vault for this template if we don't have one
    let vaultId: string;
    try {
      const vault = await api<{ id: string }>("/v1/vaults", {
        method: "POST",
        body: JSON.stringify({ name: `${selectedTemplate?.name || "agent"} credentials` }),
      });
      vaultId = vault.id;
    } catch {
      setConnectingServer(null);
      return;
    }

    // Open OAuth flow in popup
    const authUrl = `/v1/oauth/authorize?mcp_server_url=${encodeURIComponent(mcpServerUrl)}&vault_id=${encodeURIComponent(vaultId)}&redirect_uri=${encodeURIComponent(window.location.href)}`;
    window.open(authUrl, "oauth", "width=600,height=700,popup=yes");
  };

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

  const handleTemplateClick = (tmpl: (typeof AGENT_TEMPLATES)[number]) => {
    if (tmpl.id === "blank") {
      nav("/agents");
      return;
    }
    setSelectedTemplate(tmpl);
  };

  const handleCreateFromTemplate = async () => {
    if (!selectedTemplate) return;
    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        name: selectedTemplate.name,
        model: selectedTemplate.model,
        system: selectedTemplate.system,
        tools: [{ type: "agent_toolset_20260401" }],
      };
      if (selectedTemplate.mcpServers.length) payload.mcp_servers = selectedTemplate.mcpServers;
      if (selectedTemplate.skills.length) payload.skills = selectedTemplate.skills;
      const agent = await api<{ id: string }>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      nav(`/agents/${agent.id}`);
    } catch {
      nav("/agents");
    }
    setCreating(false);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 lg:p-10">
      <h1 className="font-display text-xl font-semibold tracking-tight text-fg mb-1">
        Quickstart
      </h1>
      <p className="text-fg-muted text-sm mb-6">Get up and running with managed agents in minutes.</p>

      {/* Step tabs */}
      <div className="flex overflow-x-auto border-b border-border mb-6 -mx-4 px-4 md:mx-0 md:px-0">
        {STEPS.map((s) => (
          <button
            key={s.id}
            onClick={() => setStep(s.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
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
                  className={`text-left border rounded-lg p-4 transition-all ${
                    selectedTemplate?.id === tmpl.id
                      ? "border-brand bg-brand-subtle"
                      : "border-border hover:border-brand hover:bg-bg-surface"
                  }`}
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

            {/* Template preview panel */}
            {selectedTemplate && (
              <div className="mt-4 border border-border rounded-lg bg-bg overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-surface">
                  <div>
                    <h3 className="font-medium text-fg">{selectedTemplate.name}</h3>
                    <p className="text-xs text-fg-muted mt-0.5">{selectedTemplate.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setSelectedTemplate(null)}
                      className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-border rounded-md transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateFromTemplate}
                      disabled={creating}
                      className="px-4 py-1.5 bg-brand text-brand-fg rounded-md text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
                    >
                      {creating ? "Creating..." : "Create agent"}
                    </button>
                  </div>
                </div>
                <div className="p-5 space-y-4">
                  <div>
                    <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider">Model</label>
                    <p className="text-sm text-fg mt-1 font-mono">{selectedTemplate.model}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider">System prompt</label>
                    <pre className="mt-1 text-sm text-fg-muted bg-bg-surface rounded-lg p-4 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">{selectedTemplate.system}</pre>
                  </div>
                  {selectedTemplate.mcpServers.length > 0 && (
                    <div>
                      <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider">MCP Servers</label>
                      <div className="mt-2 space-y-2">
                        {selectedTemplate.mcpServers.map((s) => {
                          const serverName = s.url.replace(/^https?:\/\/mcp\./, "").replace(/\.(com|app|dev|io)\/.*$/, "");
                          const isConnected = connectedServers.has(serverName);
                          const isConnecting = connectingServer === s.name;
                          return (
                            <div key={s.name} className="flex items-center justify-between px-3 py-2 bg-bg-surface rounded-md">
                              <span className="text-sm font-mono text-fg-muted">{s.name}</span>
                              {isConnected ? (
                                <span className="inline-flex items-center gap-1 text-xs text-success font-medium">
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                  </svg>
                                  Connected
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleConnect(s.url, s.name)}
                                  disabled={isConnecting}
                                  className="px-2.5 py-1 text-xs font-medium text-brand border border-brand rounded-md hover:bg-brand hover:text-brand-fg disabled:opacity-50 transition-colors"
                                >
                                  {isConnecting ? "Connecting..." : "Connect"}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {selectedTemplate.tags.length > 0 && (
                    <div>
                      <label className="text-xs font-medium text-fg-subtle uppercase tracking-wider">Tags</label>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {selectedTemplate.tags.map((tag) => (
                          <span key={tag} className="px-2 py-0.5 bg-bg-surface text-fg-muted rounded text-xs">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
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
