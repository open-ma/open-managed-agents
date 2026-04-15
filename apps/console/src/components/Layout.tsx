import { useState } from "react";
import { NavLink, Outlet, Navigate } from "react-router";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";

/* ── Navigation groups ── */
const navGroups = [
  {
    label: "Overview",
    items: [
      {
        to: "/",
        label: "Dashboard",
        icon: "M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z",
        end: true,
      },
    ],
  },
  {
    label: "Managed Agents",
    items: [
      {
        to: "/agents",
        label: "Agents",
        icon: "M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
      },
      {
        to: "/sessions",
        label: "Sessions",
        icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
      },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      {
        to: "/environments",
        label: "Environments",
        icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2",
      },
      {
        to: "/vaults",
        label: "Credential Vaults",
        icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
      },
    ],
  },
  {
    label: "Configuration",
    items: [
      {
        to: "/skills",
        label: "Skills",
        icon: "M13 10V3L4 14h7v7l9-11h-7z",
      },
      {
        to: "/memory",
        label: "Memory Stores",
        icon: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4",
      },
      {
        to: "/model-cards",
        label: "Model Cards",
        icon: "M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z",
      },
      {
        to: "/api-keys",
        label: "API Keys",
        icon: "M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z",
      },
    ],
  },
];

/* ── Chevron icon for collapsible groups ── */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 text-fg-subtle transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/* ── Logo ── */
function LogoMark() {
  return (
    <img src="/logo.svg" alt="openma" className="h-8 shrink-0" />
  );
}

/* ── Theme toggle ── */
const themeOptions = [
  { value: "light" as const, label: "Light" },
  { value: "dark" as const, label: "Dark" },
  { value: "system" as const, label: "System" },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center rounded-md bg-bg-surface p-0.5 gap-0.5">
      {themeOptions.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
            theme === opt.value
              ? "bg-bg text-fg font-medium shadow-sm"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── Collapsible nav group ── */
function NavGroup({
  label,
  items,
  defaultOpen = true,
}: {
  label: string;
  items: typeof navGroups[number]["items"];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs font-medium text-fg-subtle uppercase tracking-wider hover:text-fg-muted transition-colors"
      >
        {label}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item && item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-brand-subtle text-brand font-medium"
                    : "text-fg-muted hover:bg-bg-surface hover:text-fg"
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={item.icon}
                />
              </svg>
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Hamburger icon ── */
function MenuIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

/* ── User menu ── */
function UserMenu() {
  const { user } = useAuth();

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };

  if (!user) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="w-7 h-7 rounded-full bg-brand-subtle text-brand text-xs font-medium flex items-center justify-center shrink-0">
        {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg truncate">{user.name}</div>
        <div className="text-xs text-fg-subtle truncate">{user.email}</div>
      </div>
      <button
        onClick={handleSignOut}
        title="Sign out"
        className="p-1 text-fg-subtle hover:text-fg rounded transition-colors shrink-0"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
      </button>
    </div>
  );
}

/* ── Sidebar content (shared between desktop & mobile) ── */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 pt-5 pb-4 text-brand">
        <LogoMark />
        <span className="font-mono font-bold text-base">openma</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-3 overflow-y-auto" onClick={onNavigate}>
        {navGroups.map((group) => (
          <NavGroup
            key={group.label}
            label={group.label}
            items={group.items}
          />
        ))}
      </nav>

      {/* Bottom section */}
      <div className="p-3 space-y-3 border-t border-border">
        <a href="https://github.com/open-ma/open-managed-agents" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-fg-muted hover:text-fg hover:bg-bg-surface rounded-md transition-colors">
          <svg className="w-4 h-4 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
          Documentation
        </a>
        <ThemeToggle />
        <UserMenu />
      </div>
    </>
  );
}

/* ── Layout ── */
export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <div className="text-fg-subtle text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-bg">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 shrink-0 bg-bg-sidebar border-r border-border flex-col">
        <SidebarContent />
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-bg-overlay md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Mobile sidebar drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-bg-sidebar border-r border-border flex flex-col transform transition-transform duration-200 md:hidden ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Close button */}
        <button
          onClick={() => setSidebarOpen(false)}
          className="absolute top-4 right-3 p-1 text-fg-muted hover:text-fg rounded-md"
        >
          <CloseIcon />
        </button>
        <SidebarContent onNavigate={() => setSidebarOpen(false)} />
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden m-0 md:m-2">
        {/* Mobile header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1 text-fg-muted hover:text-fg rounded-md"
          >
            <MenuIcon />
          </button>
          <LogoMark />
          <span className="font-mono font-bold text-sm text-brand">openma</span>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden bg-bg md:rounded-lg md:border md:border-border">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
