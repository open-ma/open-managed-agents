import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import { NavLink, Outlet, Navigate, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { BrandLoader } from "./BrandLoader";
import { Avatar } from "./Avatar";
import { CommandPalette } from "./CommandPalette";
import { NavigationProgress } from "./NavigationProgress";
import {
  AgentIcon,
  ApiKeysIcon,
  RuntimesIcon,
  ChevronDownIcon,
  DashboardIcon,
  EnvIcon,
  FilesIcon,
  GitHubIcon,
  LinearIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  SlackIcon,
  VaultIcon,
} from "./icons";
import { consolePlugins } from "../plugins/registry";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/* ── Navigation groups — single source of truth for sidebar items ── */
const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: DashboardIcon, end: true },
    ],
  },
  {
    label: "Managed Agents",
    items: [
      { to: "/agents", label: "Agents", icon: AgentIcon },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/evals", label: "Eval Runs", icon: SessionsIcon },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/skills", label: "Skills", icon: SkillsIcon },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon },
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon },
      { to: "/runtimes", label: "Local Runtimes", icon: RuntimesIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
    ],
  },
  // Plugin-contributed groups (hosted-only extensions). Default empty
  // in OSS — hosted overlay-replaces plugins/registry.ts to add
  // billing / etc. The PluginNavItem shape mirrors NavItem above so
  // the spread is type-checked by tsc.
  ...consolePlugins.flatMap((p) => p.navGroups ?? []),
];

/* ── Linear-style chord keybindings (g + letter → route) ──
 *
 * Mapping is path → second-key. Prefix is always "g". Letter choice
 * follows Linear's convention (first letter of the route) wherever
 * possible; clashes are resolved with the second-most-meaningful letter:
 *
 *   k is taken by Skills, so API Keys uses `i` ("key id")
 *   e is taken by Environments, so Eval Runs uses `h` ("hist")
 *
 * Exported so CommandPalette can render the same chord next to each
 * route, making them discoverable without a separate cheatsheet. */
export const ROUTE_CHORDS: Record<string, string> = {
  "/":              "d",
  "/agents":        "a",
  "/sessions":      "s",
  "/files":         "f",
  "/environments":  "e",
  "/vaults":        "v",
  "/skills":        "k",
  "/memory":        "m",
  "/model-cards":   "c",
  "/api-keys":      "i",
  "/runtimes":      "r",
  "/evals":         "h",
};

/* ── Chevron icon for collapsible groups ── */
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className={`w-3.5 h-3.5 text-fg-subtle transition-transform duration-[var(--dur-base)] ease-[var(--ease-soft)] ${open ? "rotate-0" : "-rotate-90"}`}
    />
  );
}

/* ── Logo ── */
function LogoMark() {
  return <Logo size="sm" />;
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
          className={`flex-1 inline-flex items-center justify-center px-2 py-1 min-h-11 sm:min-h-0 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
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
  const panelId = `sidebar-group-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center justify-between w-full px-3 py-1.5 min-h-11 sm:min-h-0 text-xs font-medium text-fg-subtle uppercase tracking-wider hover:text-fg-muted transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
      >
        {label}
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div id={panelId} className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item && item.end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-1.5 min-h-11 sm:min-h-0 mx-1 rounded-md text-sm transition-[background-color,color,box-shadow] duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                  isActive
                    ? "bg-brand-subtle text-brand font-medium shadow-[var(--shadow-sm)]"
                    : "text-fg-muted hover:bg-bg-surface hover:text-fg"
                }`
              }
            >
              <item.icon className="w-4 h-4 opacity-60 shrink-0" />
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
      <Avatar name={user.name || user.email} size="md" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg truncate">{user.name}</div>
        <div className="text-xs text-fg-subtle truncate">{user.email}</div>
      </div>
      <button
        onClick={handleSignOut}
        title="Sign out"
        aria-label="Sign out"
        className="inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 text-fg-subtle hover:text-fg hover:bg-bg-surface rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] shrink-0"
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
      <div className="flex items-center gap-2 px-4 pt-5 pb-3 text-brand">
        <LogoMark />
        <span className="font-mono font-bold text-base">openma</span>
      </div>

      {/* Workspace switcher (hidden when user has a single tenant; lets
          owners create additional workspaces). */}
      <TenantSwitcher />

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
        <a href="https://docs.openma.dev" target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-1.5 min-h-11 sm:min-h-0 text-sm text-fg-muted hover:text-fg hover:bg-bg-surface rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
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
  const navigate = useNavigate();

  // Linear-style chord bindings. Derived from ROUTE_CHORDS so the
  // sidebar / palette / chords stay in lockstep — adding a route to
  // the map enables `g <key>` automatically. The hook itself bypasses
  // chords inside form inputs and while a Radix dialog is open, so
  // these are safe to register at the top of the authenticated layout.
  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      Object.entries(ROUTE_CHORDS).map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex h-screen bg-bg">
      <NavigationProgress />
      <CommandPalette />
      {/*
        Autofill honeypot. Chrome / Safari ignore autoComplete="off" on
        text inputs and aggressively offer the saved login email/password
        on the FIRST plausible-looking input they find. Sit a hidden
        input + password pair at the very top of the authenticated DOM so
        the browser fills it instead of any real Title / search /
        whatever input downstream. tabIndex + aria-hidden keep it out of
        keyboard nav and a11y trees.

        Why position:absolute + offscreen instead of display:none:
        browsers may skip display:none inputs entirely (no autofill at
        all → they just move on to the next visible input). Offscreen
        but in the layout tree IS visible enough for autofill heuristics
        but invisible to users.

        autoComplete=username + current-password mirrors the canonical
        login pair so the browser's heuristic matches here first.
      */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "-9999px",
          height: 0,
          width: 0,
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <input type="text" tabIndex={-1} autoComplete="username" name="username" />
        <input type="password" tabIndex={-1} autoComplete="current-password" name="password" />
      </div>

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
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-bg-sidebar border-r border-border flex flex-col transform transition-transform duration-[var(--dur-slow)] ease-[var(--ease-soft)] md:hidden ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Close button */}
        <button
          onClick={() => setSidebarOpen(false)}
          aria-label="Close menu"
          className="absolute top-3 right-3 inline-flex items-center justify-center w-11 h-11 text-fg-muted hover:text-fg hover:bg-bg-surface rounded-md"
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
            aria-label="Open menu"
            className="inline-flex items-center justify-center w-11 h-11 text-fg-muted hover:text-fg hover:bg-bg-surface rounded-md"
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
