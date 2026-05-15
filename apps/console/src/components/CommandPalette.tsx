import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  AgentIcon,
  ApiKeysIcon,
  RuntimesIcon,
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
import type { ComponentType } from "react";

interface NavCommand {
  label: string;
  to: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
  // Aliases helps fuzzy match — typing "envs" matches "Environments".
  aliases?: string;
}

// Mirrors the sidebar nav in Layout.tsx — kept inline so the palette is
// self-contained. If the sidebar gains an item, add it here too. (We
// intentionally don't auto-derive from Layout's navGroups because the
// palette wants slightly different ordering and aliases.)
const COMMANDS: NavCommand[] = [
  { label: "Dashboard",          to: "/",                          group: "Overview",       icon: DashboardIcon },
  { label: "Agents",             to: "/agents",                    group: "Managed Agents", icon: AgentIcon },
  { label: "Sessions",           to: "/sessions",                  group: "Managed Agents", icon: SessionsIcon },
  { label: "Files",              to: "/files",                     group: "Managed Agents", icon: FilesIcon },
  { label: "Eval Runs",          to: "/evals",                     group: "Managed Agents", icon: SessionsIcon, aliases: "evaluations evals" },
  { label: "Environments",       to: "/environments",              group: "Infrastructure", icon: EnvIcon, aliases: "envs sandboxes" },
  { label: "Credential Vaults",  to: "/vaults",                    group: "Infrastructure", icon: VaultIcon, aliases: "secrets credentials" },
  { label: "Skills",             to: "/skills",                    group: "Configuration",  icon: SkillsIcon },
  { label: "Memory Stores",      to: "/memory",                    group: "Configuration",  icon: MemoryIcon },
  { label: "Model Cards",        to: "/model-cards",               group: "Configuration",  icon: ModelCardsIcon },
  { label: "API Keys",           to: "/api-keys",                  group: "Configuration",  icon: ApiKeysIcon, aliases: "tokens" },
  { label: "Local Runtimes",     to: "/runtimes",                  group: "Configuration",  icon: RuntimesIcon },
  { label: "Linear",             to: "/integrations/linear",       group: "Integrations",   icon: LinearIcon },
  { label: "GitHub",             to: "/integrations/github",       group: "Integrations",   icon: GitHubIcon },
  { label: "Slack",              to: "/integrations/slack",        group: "Integrations",   icon: SlackIcon },
];

/**
 * Global Cmd+K (⌘K / Ctrl+K) command palette. Quick-jump anywhere in the
 * console without going through the sidebar. Mounts once at the layout
 * level; listens on `window` for the keybinding.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K on mac, Ctrl+K everywhere else. Same combo as Linear, Raycast,
      // Slack — universal "open command palette".
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (cmdK) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };

  // Group commands by their `group` field for cmdk's grouped rendering.
  const grouped = COMMANDS.reduce<Record<string, NavCommand[]>>((acc, cmd) => {
    (acc[cmd.group] ??= []).push(cmd);
    return acc;
  }, {});

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="modal-overlay fixed inset-0 bg-bg-overlay z-50"
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="modal-content fixed top-[20%] left-1/2 -translate-x-1/2 z-50 w-full max-w-lg bg-bg border border-border rounded-lg shadow-xl overflow-hidden"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter className="flex flex-col">
            <div className="flex items-center gap-2 px-3 border-b border-border">
              <span aria-hidden className="text-fg-subtle text-xs font-mono">[</span>
              <Command.Input
                placeholder="Jump to…"
                className="flex-1 h-12 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
              <kbd className="text-[10px] text-fg-subtle font-mono px-1.5 py-0.5 rounded bg-bg-surface border border-border">
                esc
              </kbd>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
                No matches.
              </Command.Empty>
              {Object.entries(grouped).map(([group, items]) => (
                <Command.Group
                  key={group}
                  heading={
                    <span className="px-2 py-1 text-[10px] font-medium text-fg-subtle uppercase tracking-wider">
                      {group}
                    </span>
                  }
                >
                  {items.map((cmd) => {
                    const Icon = cmd.icon;
                    return (
                      <Command.Item
                        key={cmd.to}
                        value={`${cmd.label} ${cmd.aliases ?? ""}`}
                        onSelect={() => go(cmd.to)}
                        className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-fg cursor-pointer data-[selected=true]:bg-bg-surface data-[selected=true]:text-fg"
                      >
                        <Icon className="w-4 h-4 opacity-60 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{cmd.label}</span>
                        <span className="text-[11px] text-fg-subtle">{cmd.group}</span>
                      </Command.Item>
                    );
                  })}
                </Command.Group>
              ))}
            </Command.List>
            <div className="px-3 py-2 border-t border-border text-[11px] text-fg-subtle flex items-center justify-between font-mono">
              <span>↑↓ navigate · ↵ select</span>
              <span>⌘K to toggle</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
