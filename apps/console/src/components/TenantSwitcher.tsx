import { useEffect, useRef, useState } from "react";
import { useApi, getActiveTenantId, setActiveTenantId } from "../lib/api";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Avatar } from "./Avatar";

// Slot beneath the logo in the sidebar. Hidden when the user has only one
// tenant — single-tenant accounts shouldn't even see the workspace concept.
// When clicked, opens a dropdown with all memberships + a "Create workspace"
// button. Switching writes localStorage and reloads the page so every
// already-mounted query refetches under the new tenant.

interface Tenant {
  id: string;
  name: string;
  role: string;
}

function displayName(t: Tenant): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) return t.id;
  return trimmed;
}

export function TenantSwitcher() {
  const { api } = useApi();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [active, setActive] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ data: Tenant[] }>("/v1/me/tenants")
      .then((res) => {
        setTenants(res.data);
        // First-time / no active set: pick whichever tenant the backend
        // resolved (which itself fell back to user.tenantId). Persist so
        // future requests pin it explicitly.
        const stored = getActiveTenantId();
        if (stored && res.data.some((t) => t.id === stored)) {
          setActive(stored);
        } else if (res.data.length > 0) {
          setActive(res.data[0].id);
          setActiveTenantId(res.data[0].id);
        }
      })
      .catch(() => {
        // Pre-auth or backend down — sidebar just hides the switcher.
      });
    // useApi() returns a fresh { api, streamEvents } closure every render,
    // so listing `api` as a dep would re-fire this effect infinitely and
    // hammer /v1/me/tenants. Mount-once is the right semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const switchTo = (id: string) => {
    setActiveTenantId(id);
    // Full reload — cheaper than threading active-tenant context through
    // every page's query state. Acceptable cost: sub-second on modern HW.
    window.location.reload();
  };

  // Hide entirely when there's nothing to switch and no chance of needing
  // to (single tenant, never had multi). Plus button still useful if user
  // wants to spin up a second workspace.
  if (tenants.length === 0) return null;

  const current = tenants.find((t) => t.id === active);

  return (
    <>
      <div className="px-3 pt-1 pb-2 relative" ref={dropdownRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Switch workspace"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2.5 py-2 min-h-11 sm:min-h-0 rounded-md hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] text-left group"
        >
          <Avatar name={current?.name ?? "?"} size="sm" squared />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate text-fg">
              {current ? displayName(current) : "Workspace"}
            </div>
            {current && tenants.length > 1 && (
              <div className="text-[10px] text-fg-subtle uppercase tracking-wider">
                {current.role}
              </div>
            )}
          </div>
          <svg className="w-3.5 h-3.5 text-fg-subtle shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {open && (
          <div role="menu" aria-label="Workspaces" className="absolute left-3 right-3 top-full mt-1 z-30 bg-bg border border-border rounded-lg shadow-lg overflow-hidden">
            <div className="max-h-72 overflow-y-auto py-1">
              {tenants.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.id === active}
                  onClick={() => switchTo(t.id)}
                  className={`w-full text-left px-3 py-2 min-h-11 sm:min-h-0 text-sm hover:bg-bg-surface flex items-center gap-2 ${t.id === active ? "bg-bg-surface/60" : ""}`}
                >
                  <Avatar name={displayName(t)} size="xs" squared />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{displayName(t)}</div>
                    <div className="text-[10px] text-fg-subtle font-mono">{t.id}</div>
                  </div>
                  {t.id === active && (
                    <svg className="w-3.5 h-3.5 text-success shrink-0" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            <div className="border-t border-border">
              <button
                onClick={() => { setOpen(false); setCreateOpen(true); }}
                className="w-full text-left px-3 py-2 min-h-11 sm:min-h-0 text-sm text-fg-muted hover:bg-bg-surface flex items-center gap-2"
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Create workspace…
              </button>
            </div>
          </div>
        )}
      </div>

      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          // Optimistic: append to list and switch immediately. The reload
          // ensures every page refetches with the new tenant header.
          setActiveTenantId(t.id);
          window.location.reload();
        }}
      />
    </>
  );
}

function CreateTenantModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const { api } = useApi();
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorking(true);
    setError("");
    try {
      const res = await api<Tenant>("/v1/tenants", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create workspace">
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          A workspace is an isolated container for agents, sessions, vaults,
          and integrations. You'll be the owner of the new one.
        </p>
        <div>
          <label htmlFor="tenant-create-name" className="block text-xs uppercase tracking-wider text-fg-subtle mb-1">
            Name
          </label>
          <input
            id="tenant-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Acme Production"
            autoFocus
            disabled={working}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-border-strong"
          />
        </div>
        {error && (
          <div className="bg-danger-subtle border border-danger/30 text-danger text-sm rounded px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={working}
            className="inline-flex items-center justify-center px-4 py-2 min-h-11 sm:min-h-0 rounded-lg border border-border text-sm text-fg-muted hover:bg-bg-surface disabled:opacity-40"
          >
            Cancel
          </button>
          <Button onClick={submit} disabled={working || !name.trim()}>
            {working ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
