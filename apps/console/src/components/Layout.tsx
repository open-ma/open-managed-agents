import { NavLink, Outlet } from "react-router";
import { useAuth } from "../lib/auth";

const nav = [
  { to: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" },
  { to: "/agents", label: "Agents", icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
  { to: "/sessions", label: "Sessions", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { to: "/environments", label: "Environments", icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" },
  { to: "/skills", label: "Skills", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { to: "/vaults", label: "Credential Vaults", icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" },
  { to: "/memory", label: "Memory Stores", icon: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" },
];

export function Layout() {
  const { apiKey, setApiKey } = useAuth();

  return (
    <div className="flex h-screen p-2.5 gap-2.5">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 bg-stone-900 text-stone-300 rounded-2xl flex flex-col overflow-hidden shadow-xl">
        <div className="px-5 pt-5 pb-4 text-white font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight">
          Managed Agents
        </div>

        <nav className="flex-1 px-2 space-y-0.5">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-stone-700 text-white font-medium"
                    : "hover:bg-stone-800"
                }`
              }
            >
              <svg
                className="w-4 h-4 opacity-60 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={n.icon} />
              </svg>
              {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-white/10">
          <label className="text-xs text-stone-500 block mb-1">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter API key..."
            className="w-full bg-stone-800 border border-transparent text-stone-300 px-2.5 py-1.5 rounded text-sm outline-none focus:border-[var(--color-accent)] transition-colors placeholder:text-stone-600"
          />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-stone-50 rounded-2xl border border-stone-200/60 shadow-sm">
        <Outlet />
      </main>
    </div>
  );
}
