import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";
import { Select, SelectOption } from "../components/Select";
import { useToast } from "../components/Toast";

// =================================================================
// Types
// =================================================================

/** Package managers exposed in the UI dropdown.
 *  NOTE: `gem` exists in the schema but is intentionally omitted —
 *  OMA's sandbox-base doesn't have ruby installed yet. If the env
 *  already carries gem packages we round-trip them on save so we
 *  don't silently drop user data. */
const MANAGERS = ["apt", "cargo", "go", "npm", "pip"] as const;
type Manager = (typeof MANAGERS)[number];
const ALL_MANAGERS = [...MANAGERS, "gem"] as const;
type AnyManager = (typeof ALL_MANAGERS)[number];

interface NetworkingConfig {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

interface EnvConfigBlock {
  type: string;
  packages?: Partial<Record<AnyManager, string[]>>;
  networking?: NetworkingConfig;
  dockerfile?: string;
}

interface Env {
  id: string;
  name: string;
  description?: string;
  config: EnvConfigBlock;
  status?: "building" | "ready" | "error";
  build_error?: string;
  metadata?: Record<string, unknown>;
  image_strategy?: "base_snapshot" | "dockerfile";
  created_at: string;
  updated_at?: string;
  archived_at?: string;
}

// Local editor row shapes — packages and metadata both use ordered
// row arrays so the UI keeps a stable visual position while editing,
// rather than reshuffling whenever the underlying object's key order
// changes during normalize-on-save.
interface PackageRow {
  manager: Manager;
  /** Space-separated package specs, e.g. `pandas numpy==2.0` */
  packages: string;
}
interface MetadataRow {
  key: string;
  value: string;
}

// =================================================================
// Page
// =================================================================

export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const { toast } = useToast();
  const nav = useNavigate();

  const [env, setEnv] = useState<Env | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable form state (kept separate from `env` so Cancel can revert
  // without re-fetching, and so we can diff to detect "dirty" later if
  // we ever want to show an unsaved-changes guard).
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [networking, setNetworking] = useState<NetworkingConfig>({
    type: "unrestricted",
    allow_mcp_servers: false,
    allow_package_managers: false,
    allowed_hosts: [],
  });
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [packageRows, setPackageRows] = useState<PackageRow[]>([]);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  // `gem` packages aren't editable (no UI row) — preserved verbatim
  // so save doesn't silently strip them.
  const [preservedGem, setPreservedGem] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api<Env>(`/v1/environments/${id}`)
      .then((e) => {
        if (cancelled) return;
        applyEnv(e);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "load failed");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  function applyEnv(e: Env) {
    setEnv(e);
    setName(e.name);
    setDescription(e.description ?? "");

    const net: NetworkingConfig = e.config.networking ?? { type: "unrestricted" };
    setNetworking({
      type: net.type ?? "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
      allowed_hosts: net.allowed_hosts ?? [],
    });
    setAllowedHostsText((net.allowed_hosts ?? []).join(", "));

    setPackageRows(packagesToRows(e.config.packages));
    setPreservedGem(e.config.packages?.gem);

    setMetadataRows(metadataToRows(e.metadata));
  }

  async function save() {
    if (!id || !env) return;
    setSaving(true);
    try {
      const config: EnvConfigBlock = {
        // Preserve type ("cloud") and any dockerfile field — we don't expose
        // dockerfile in MVP UI, so it must round-trip untouched.
        type: env.config.type,
        ...(env.config.dockerfile !== undefined ? { dockerfile: env.config.dockerfile } : {}),
        packages: rowsToPackages(packageRows, preservedGem),
        networking: buildNetworking(networking, allowedHostsText),
      };

      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        config,
        // metadata isn't currently parsed by the PUT route — sent here so
        // the field is present once the backend wires it up. No-op today.
        metadata: rowsToMetadata(metadataRows),
      };

      const updated = await api<Env>(`/v1/environments/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      applyEnv(updated);
      toast("Environment saved", "success");
    } catch (err) {
      // useApi already toasts the underlying error; no duplicate here.
      void err;
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    nav("/environments");
  }

  if (loadError) {
    return (
      <div className="flex-1 p-8">
        <Link to="/environments" className="text-sm text-fg-muted hover:text-fg">
          &larr; Environments
        </Link>
        <div className="mt-4 bg-danger-subtle border border-danger/30 rounded-lg p-4 text-danger text-sm">
          {loadError}
        </div>
      </div>
    );
  }
  if (!env) {
    return <div className="flex-1 p-8 text-fg-muted">Loading...</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 md:p-8 lg:p-10">
      {/* Breadcrumb */}
      <div className="text-sm text-fg-muted mb-4 flex items-center gap-1.5">
        <Link to="/environments" className="hover:text-fg transition-colors">
          Environments
        </Link>
        <span className="text-fg-subtle">/</span>
        <span className="text-fg truncate" title={env.name}>{env.name}</span>
      </div>

      <div className="max-w-3xl space-y-6">
        {/* Header: name input + Cloud badge + status */}
        <section className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              className="border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors w-full sm:w-72"
              placeholder="environment name"
            />
            <span className="text-[11px] px-2 py-0.5 rounded border border-border bg-bg-surface text-fg-muted font-medium uppercase tracking-wider">
              Cloud
            </span>
            <span className="text-fg-subtle" aria-hidden="true">
              <GlobeIcon />
            </span>
            {/* Status chip + build_error banner removed — env is stateless
                post setup-on-warmup migration; status is always "ready"
                (and the field is no longer surfaced on the wire). Package
                install errors surface on the first session that uses the
                env, not at env-creation time. */}
          </div>

          <div>
            <label className="block text-[13px] font-medium text-fg mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle resize-y"
              placeholder="What is this environment for?"
            />
          </div>
        </section>

        {/* Networking */}
        <SectionCard
          title="Networking"
          subtitle="Configure network access policies for sandboxes built from this environment."
        >
          <div className="space-y-4">
            <Field label="Type">
              <div className="w-48">
                <Select
                  value={networking.type}
                  onValueChange={(v) =>
                    setNetworking({
                      ...networking,
                      type: v as NetworkingConfig["type"],
                    })
                  }
                >
                  <SelectOption value="unrestricted">Unrestricted</SelectOption>
                  <SelectOption value="limited">Limited</SelectOption>
                </Select>
              </div>
            </Field>

            <Toggle
              label="Allow MCP server network access"
              checked={!!networking.allow_mcp_servers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_mcp_servers: v })
              }
            />
            <Toggle
              label="Allow package manager network access"
              checked={!!networking.allow_package_managers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_package_managers: v })
              }
            />

            {networking.type === "limited" && (
              <Field
                label="Allowed Hosts"
                hint="Comma-separated hostnames (e.g. www.example1.com, api.example2.com)"
              >
                <textarea
                  value={allowedHostsText}
                  onChange={(e) => setAllowedHostsText(e.target.value)}
                  rows={2}
                  className="w-full border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle resize-y"
                  placeholder="www.example1.com, www.example2.com"
                />
              </Field>
            )}
          </div>
        </SectionCard>

        {/* Packages */}
        <SectionCard
          title="Packages"
          subtitle="Specify packages and their versions to install when sandboxes are built."
          action={
            <IconButton
              label="Add package row"
              onClick={() =>
                setPackageRows((rows) => [...rows, { manager: "pip", packages: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          {packageRows.length === 0 ? (
            <p className="text-[13px] text-fg-subtle italic">
              No packages configured.
            </p>
          ) : (
            <div className="space-y-2">
              {packageRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-24 shrink-0">
                    <Select
                      value={row.manager}
                      onValueChange={(v) =>
                        setPackageRows((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, manager: v as Manager } : r,
                          ),
                        )
                      }
                    >
                      {MANAGERS.map((m) => (
                        <SelectOption key={m} value={m}>{m}</SelectOption>
                      ))}
                    </Select>
                  </div>
                  <input
                    value={row.packages}
                    onChange={(e) =>
                      setPackageRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, packages: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="package package==1.0.0"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle font-mono"
                  />
                  <IconButton
                    label="Remove package row"
                    onClick={() =>
                      setPackageRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {preservedGem && preservedGem.length > 0 && (
            <p className="text-[12px] text-fg-subtle mt-3 pt-3 border-t border-border">
              {preservedGem.length} legacy gem package(s) preserved (not editable
              — Ruby is not in sandbox-base yet).
            </p>
          )}
        </SectionCard>

        {/* Metadata */}
        <SectionCard
          title="Metadata"
          subtitle="Add custom key-value pairs to tag this environment."
          action={
            <IconButton
              label="Add metadata row"
              onClick={() =>
                setMetadataRows((rows) => [...rows, { key: "", value: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          {metadataRows.length === 0 ? (
            <p className="text-[13px] text-fg-subtle italic">No metadata.</p>
          ) : (
            <div className="space-y-2">
              {metadataRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={row.key}
                    onChange={(e) =>
                      setMetadataRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, key: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="client_key"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle font-mono"
                  />
                  <input
                    value={row.value}
                    onChange={(e) =>
                      setMetadataRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="Value"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-[13px] bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle"
                  />
                  <IconButton
                    label="Remove metadata row"
                    onClick={() =>
                      setMetadataRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Footer actions */}
        <div className="flex items-center gap-3 pt-2">
          <Button onClick={save} loading={saving} disabled={!name.trim()}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <span className="text-xs text-fg-subtle ml-auto font-mono">
            {env.id}
          </span>
        </div>
      </div>
    </div>
  );
}

// =================================================================
// Section / form primitives
// =================================================================

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border rounded-lg bg-bg-surface/30">
      <header className="px-4 py-3 border-b border-border flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-fg">{title}</h2>
          {subtitle && (
            <p className="text-[12px] text-fg-muted mt-0.5">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-fg mb-1.5">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-fg-muted">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <span className="text-[13px] text-fg">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none ${
          checked ? "bg-brand" : "bg-bg-surface border border-border"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}

function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface transition-colors"
    >
      {children}
    </button>
  );
}

// =================================================================
// Icons
// =================================================================

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8h-7A2 2 0 0 1 6.5 20L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

// =================================================================
// Pure helpers — kept module-level so they can be unit-tested without
// pulling React in. They handle the schema <-> editor-row mapping for
// packages and metadata.
// =================================================================

function packagesToRows(
  packages: Partial<Record<AnyManager, string[]>> | undefined,
): PackageRow[] {
  if (!packages) return [];
  const rows: PackageRow[] = [];
  for (const m of MANAGERS) {
    const list = packages[m];
    if (list && list.length > 0) {
      rows.push({ manager: m, packages: list.join(" ") });
    }
  }
  return rows;
}

function rowsToPackages(
  rows: PackageRow[],
  preservedGem?: string[],
): Partial<Record<AnyManager, string[]>> {
  const out: Partial<Record<AnyManager, string[]>> = {};
  for (const row of rows) {
    const specs = row.packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) continue;
    // Multiple rows with the same manager merge — user-friendly default
    // since the UI doesn't enforce uniqueness.
    const existing = out[row.manager] ?? [];
    out[row.manager] = [...existing, ...specs];
  }
  if (preservedGem && preservedGem.length > 0) {
    out.gem = preservedGem;
  }
  return out;
}

function metadataToRows(
  metadata: Record<string, unknown> | undefined,
): MetadataRow[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function rowsToMetadata(rows: MetadataRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  return out;
}

function buildNetworking(
  net: NetworkingConfig,
  allowedHostsText: string,
): NetworkingConfig {
  const hosts = allowedHostsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (net.type === "unrestricted") {
    return {
      type: "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
      // Drop allowed_hosts when unrestricted — it's meaningless and the
      // backend may complain about stale entries.
    };
  }
  return {
    type: "limited",
    allow_mcp_servers: !!net.allow_mcp_servers,
    allow_package_managers: !!net.allow_package_managers,
    allowed_hosts: hosts,
  };
}
