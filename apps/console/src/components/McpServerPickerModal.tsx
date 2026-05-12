// Pick a known MCP server from the shared MCP_REGISTRY (same registry the
// vault page's "Connect a service" flow uses). Keeps the agent-config
// form, the vault-credential flow, and any future consumer (session
// creation, integration UI, etc.) in sync — adding a new server to the
// registry surfaces it everywhere automatically.
//
// Usage:
//
//   <McpServerPickerModal
//     open={...}
//     onClose={...}
//     alreadyAddedUrls={form.mcpServers.map((s) => s.url)}  // disables row + shows "Added"
//     onPick={(entry) => { addToYourForm(entry); }}
//   />
//
// The modal closes itself after a pick — caller doesn't need to manage that.

import { useState } from "react";
import { Modal } from "./Modal";
import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

export interface McpServerPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** URLs already added in the calling form — picker shows them disabled
   *  with an "Added" badge instead of letting the user double-add. */
  alreadyAddedUrls?: ReadonlyArray<string>;
  onPick: (entry: McpRegistryEntry) => void;
}

export function McpServerPickerModal({
  open,
  onClose,
  alreadyAddedUrls = [],
  onPick,
}: McpServerPickerModalProps): JSX.Element {
  const [search, setSearch] = useState("");
  const addedSet = new Set(alreadyAddedUrls);
  const filtered = search
    ? MCP_REGISTRY.filter(
        (e) =>
          e.name.toLowerCase().includes(search.toLowerCase()) ||
          e.url.toLowerCase().includes(search.toLowerCase()),
      )
    : MCP_REGISTRY;

  return (
    <Modal
      open={open}
      onClose={() => {
        onClose();
        setSearch("");
      }}
      title="Pick a known MCP server"
      subtitle="Same registry the vault's Connect Service flow uses."
      maxWidth="max-w-lg"
    >
      <div className="space-y-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={inputCls}
          placeholder="Search services"
          autoFocus
        />
        <div className="max-h-80 overflow-y-auto -mx-1">
          {filtered.map((entry) => {
            const alreadyAdded = addedSet.has(entry.url);
            return (
              <button
                key={entry.id}
                onClick={() => {
                  if (alreadyAdded) return;
                  onPick(entry);
                  onClose();
                  setSearch("");
                }}
                disabled={alreadyAdded}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors ${
                  alreadyAdded
                    ? "opacity-50 cursor-default"
                    : "hover:bg-bg-surface cursor-pointer"
                }`}
              >
                {entry.icon ? (
                  <img
                    src={entry.icon}
                    alt=""
                    className="w-5 h-5 rounded shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-5 h-5 rounded bg-bg-surface shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">{entry.name}</div>
                  <div className="text-xs text-fg-muted font-mono truncate">{entry.url}</div>
                </div>
                {alreadyAdded && (
                  <span className="text-xs text-fg-subtle shrink-0">Added</span>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="text-center py-6 text-fg-subtle text-sm">
              No matches. Use "+ Custom URL" to add a custom MCP server.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
