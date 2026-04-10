import { useNavigate } from "react-router";

export function Dashboard() {
  const nav = useNavigate();

  const cards = [
    { title: "Agents", desc: "Create and manage autonomous agents", to: "/agents", count: null },
    { title: "Sessions", desc: "Trace and debug agent sessions", to: "/sessions", count: null },
    { title: "Environments", desc: "Configure sandbox environments", to: "/environments", count: null },
    { title: "Credential Vaults", desc: "Manage API keys and secrets", to: "/vaults", count: null },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight mb-1">
        Dashboard
      </h1>
      <p className="text-stone-500 text-sm mb-8">Manage your agents and sessions.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <button
            key={c.to}
            onClick={() => nav(c.to)}
            className="text-left border border-stone-200 rounded-xl p-5 hover:border-stone-400 hover:shadow transition-all cursor-pointer"
          >
            <div className="font-semibold mb-1">{c.title}</div>
            <div className="text-sm text-stone-500">{c.desc}</div>
          </button>
        ))}
      </div>

      <div className="mt-10 border border-stone-200 rounded-xl p-6 max-w-2xl">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold mb-3">Quick Start</h2>
        <pre className="bg-stone-100 rounded-lg p-4 text-sm overflow-x-auto font-[family-name:var(--font-mono)] text-stone-700 leading-relaxed">{`# Create an agent
curl /v1/agents -H "x-api-key: \$KEY" \\
  -H "content-type: application/json" \\
  -d '{"name":"Coder","model":"claude-sonnet-4-6"}'

# Create environment
curl /v1/environments -H "x-api-key: \$KEY" \\
  -H "content-type: application/json" \\
  -d '{"name":"dev","config":{"type":"cloud"}}'

# Create session & send message
curl /v1/sessions/\$SID/events -H "x-api-key: \$KEY" \\
  -H "content-type: application/json" \\
  -d '{"events":[{"type":"user.message",
    "content":[{"type":"text","text":"Hello"}]}]}'`}</pre>
      </div>
    </div>
  );
}
