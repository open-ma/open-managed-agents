import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Controller, useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArchiveIcon, TrashIcon } from "lucide-react";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { ApiError } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Modal } from "../components/Modal";
import { Select, SelectOption } from "../components/Select";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Combobox } from "../components/Combobox";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { readManagedMetadataObject } from "../lib/managed-metadata";

import type { SessionRecord as Session } from "../types/session";

interface Vault { id: string; display_name: string; }
interface FilePick { id: string; filename: string; size_bytes: number; }
interface MemoryStorePick { id: string; name: string; }

type AgentLite = {
  id: string;
  name: string;
};

// Session status options for the toolbar status chip. "any" maps to no
// server filter; the other four match the SessionStatus union in
// @anthropic-ai/sdk (idle | running | rescheduling | terminated).
type StatusValue = "any" | "idle" | "running" | "rescheduling" | "terminated";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "idle", label: "Idle" },
  { value: "running", label: "Running" },
  { value: "rescheduling", label: "Rescheduling" },
  { value: "terminated", label: "Terminated" },
];

// ────────────────────────────────────────────────────────────────────────
// Form schema (zod)
// ────────────────────────────────────────────────────────────────────────

/** GitHub repo resource. URL + token are required; the rest are optional
 *  knobs that submit() either passes through or computes a sensible
 *  default for (mount_path → /workspace/<repo-name>). */
const GithubResourceSchema = z.object({
  kind: z.literal("github"),
  url: z.string().min(1, "Repository URL is required"),
  token: z.string().min(1, "Authorization token is required"),
  checkout_type: z.enum(["none", "branch", "commit"]),
  checkout_name: z.string(),
  mount_path: z.string(),
});

const FileResourceSchema = z.object({
  kind: z.literal("file"),
  file_id: z.string(),
  mount_path: z.string(),
});

const MemoryStoreResourceSchema = z.object({
  kind: z.literal("memory_store"),
  memory_store_id: z.string(),
  access: z.enum(["read_write", "read_only"]),
});

/** Discriminated union — `kind` selects which fields apply. Mapped to the
 *  wire `{type, ...}` resource object at submit time (see `onSubmit`). */
const ResourceSchema = z.discriminatedUnion("kind", [
  GithubResourceSchema,
  FileResourceSchema,
  MemoryStoreResourceSchema,
]);

const FormSchema = z.object({
  agent: z.string().min(1, "Select an agent"),
  environment_id: z.string().min(1, "Select an environment"),
  title: z.string(),
  vault_ids: z.array(z.string()),
  resources: z.array(ResourceSchema),
});

type FormValues = z.infer<typeof FormSchema>;
type ResourceRow = z.infer<typeof ResourceSchema>;

const INITIAL_FORM_VALUES: FormValues = {
  agent: "",
  environment_id: "",
  title: "",
  vault_ids: [],
  resources: [],
};

function blankResource(kind: ResourceRow["kind"]): ResourceRow {
  switch (kind) {
    case "github": return { kind, url: "", token: "", checkout_type: "none", checkout_name: "", mount_path: "" };
    case "file": return { kind, file_id: "", mount_path: "" };
    case "memory_store": return { kind, memory_store_id: "", access: "read_write" };
  }
}

function kindLabel(kind: ResourceRow["kind"]): string {
  switch (kind) {
    case "github": return "GitHub repository";
    case "file": return "File";
    case "memory_store": return "Memory store";
  }
}

/** Best-effort `<repo-name>` extraction from GitHub URL forms. Used to
 *  derive the default mount path /workspace/<repo-name>. Returns null when
 *  the URL doesn't look like GitHub (caller falls back to /workspace). */
function parseGitHubRepoName(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (!trimmed) return null;
  // Full URL: https://github.com/owner/repo
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts[1] || null;
  } catch {
    // SSH: git@github.com:owner/repo
    const ssh = trimmed.match(/^git@github\.com:[^/]+\/([^/]+)$/);
    if (ssh) return ssh[1];
    // Bare: owner/repo
    const bare = trimmed.match(/^[^/]+\/([^/]+)$/);
    if (bare) return bare[1];
    return null;
  }
}

function defaultMountPath(githubUrl: string): string {
  const name = parseGitHubRepoName(githubUrl);
  return name ? `/workspace/${name}` : "/workspace";
}

/** Tiny "🔗 Linear" pill shown when a session was triggered by a Linear webhook. */
function LinearBadge({ metadata }: { metadata?: Record<string, string> }) {
  const linear = readManagedMetadataObject(metadata, "linear") as
    | { issueIdentifier?: string; issueId?: string; workspaceId?: string }
    | null;
  if (!linear || (!linear.issueId && !linear.issueIdentifier)) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-info-subtle text-info"
      title={`Linear issue ${linear.issueIdentifier ?? linear.issueId}`}
    >
      🔗 {linear.issueIdentifier ?? "Linear"}
    </span>
  );
}

/** Tiny "💬 Slack" pill shown when a session was triggered by a Slack event. */
function SlackBadge({ metadata }: { metadata?: Record<string, string> }) {
  const slack = readManagedMetadataObject(metadata, "slack") as
    | { channelId?: string; threadTs?: string; workspaceId?: string }
    | null;
  if (!slack || (!slack.channelId && !slack.threadTs)) return null;
  const label = slack.channelId
    ? slack.channelId.startsWith("D")
      ? "DM"
      : slack.channelId
    : "Slack";
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-accent-violet-subtle text-accent-violet"
      title={`Slack channel ${slack.channelId}${slack.threadTs ? ` thread ${slack.threadTs}` : ""}`}
    >
      💬 {label}
    </span>
  );
}

/** Tiny "🧪 Eval" pill shown when a session was spawned by an eval-runner trial. */
function EvalBadge({ metadata }: { metadata?: Record<string, string> }) {
  const ev = readManagedMetadataObject(metadata, "eval") as
    | { run_id?: string; task_id?: string }
    | null;
  if (!ev?.run_id) return null;
  return (
    <a
      href={`/evals/${ev.run_id}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-info-subtle text-info hover:opacity-80 transition-opacity"
      title={`Eval run ${ev.run_id}${ev.task_id ? ` · task ${ev.task_id}` : ""}`}
    >
      🧪 {ev.task_id ?? "Eval"}
    </a>
  );
}

export function SessionsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  // Agent's MCP servers (from /v1/agents/{id} fetched on pick). Used to
  // warn the user when their selected vaults don't carry credentials for
  // a server the agent is configured to use — agent will hit those MCP
  // endpoints unauthenticated and fail mid-conversation.
  const [agentMcpUrls, setAgentMcpUrls] = useState<string[]>([]);
  // Per-vault credential hostnames cache. Populated lazily as the user
  // toggles vaults. Lookups are by hostname (matches outbound proxy logic
  // in apps/main/src/routes/mcp-proxy.ts:resolveOutboundCredentialByHost).
  const [vaultCredHosts, setVaultCredHosts] = useState<Record<string, Set<string>>>({});
  const [envs, setEnvs] = useState<Array<{ id: string; name: string }>>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [files, setFiles] = useState<FilePick[]>([]);
  const [memoryStores, setMemoryStores] = useState<MemoryStorePick[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  // Per-field reveal toggle for any masked input (env value, github token).
  // Keyed by `${idx}:${field}`. We intentionally don't try to keep stale
  // entries valid across resource list mutations — adding/removing a row
  // just clears the set, which costs at worst one re-click.
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const toggleReveal = (key: string) => setRevealedSecrets((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const inputCls = "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  // Server-driven filter state. Each piece flows into sessionsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [status, setStatus] = useState<StatusValue>("any");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  // Sessions table — cursor-paginated, server-side filtered. Any change to
  // these params resets to page 0 automatically (paramsKey is part of the
  // query key).
  const sessionsParams = useMemo(
    () => ({
      ...(filterAgent ? { agent_id: filterAgent } : {}),
      ...(status !== "any" ? { "statuses[]": status } : {}),
      ...(created.after !== undefined
        ? { "created_at[gte]": new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { "created_at[lte]": new Date(created.before).toISOString() }
        : {}),
    }),
    [filterAgent, status, created.after, created.before],
  );
  const {
    items: sessions,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshSessions,
  } = useInfiniteApiQuery<Session>("/v1/sessions", { limit: 20, params: sessionsParams });

  // ── Form (react-hook-form + zod) ──
  const resolver = useMemo(
    () =>
      // Cast addresses a workspace zod version skew: the resolver's bundled
      // .d.ts resolves `zod/v4/core` to the root install (currently 4.3.x,
      // version.minor=3) while console's own zod is 4.4.x (minor=4). Both
      // are wire-compatible at runtime; only the structural type guard on
      // _zod.version trips. No behavior change.
      zodResolver(FormSchema as never) as Resolver<FormValues>,
    [],
  );

  const form = useForm<FormValues>({
    resolver,
    defaultValues: INITIAL_FORM_VALUES,
    mode: "onChange",
  });
  const {
    control,
    register,
    handleSubmit,
    getValues,
    setValue,
    reset,
    watch,
    formState,
  } = form;

  // useFieldArray manages the dynamic resources list (append/remove/etc.).
  // Each `field` carries an `id` we use as React key — never index, since
  // remove() shifts indices and would break input identity otherwise.
  const {
    fields: resourceFields,
    append: appendResource,
    remove: removeResourceAt,
  } = useFieldArray({ control, name: "resources" });

  // ── Watch form values that drive side-effects / conditional UI ──
  const watchedAgentId = watch("agent");
  const watchedVaultIds = watch("vault_ids");
  const watchedResources = watch("resources");

  // Fetch the picked agent's mcp_servers list. Combobox only carries the
  // light row (id/name); we need the full row to know
  // which MCP endpoints the agent will dial. Refetch on agent change;
  // clear on unselect.
  useEffect(() => {
    if (!watchedAgentId) {
      setAgentMcpUrls([]);
      return;
    }
    let cancelled = false;
    managedApi.agents.retrieve(watchedAgentId)
      .then((row) => {
        if (cancelled) return;
        const urls = (row.mcp_servers ?? [])
          .map((s) => s.url)
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        setAgentMcpUrls(urls);
      })
      .catch(() => {
        if (!cancelled) setAgentMcpUrls([]);
      });
    return () => { cancelled = true; };
  }, [watchedAgentId, managedApi]);

  // Lazy-load credential hostnames for any newly-selected vault. Cache
  // forever within this modal lifetime — credential rotation mid-form is
  // not a real workflow.
  useEffect(() => {
    const missing = watchedVaultIds.filter((vid) => !(vid in vaultCredHosts));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (vid) => {
        try {
          const r = await managedApi.vaults.credentials.list(vid, { limit: 100 });
          const hosts = new Set<string>();
          for (const cred of r.data) {
            const u = "mcp_server_url" in cred.auth
              ? cred.auth.mcp_server_url
              : undefined;
            if (!u) continue;
            try { hosts.add(new URL(u).hostname); } catch { /* ignore malformed */ }
          }
          return [vid, hosts] as const;
        } catch {
          return [vid, new Set<string>()] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setVaultCredHosts((prev) => {
        const next = { ...prev };
        for (const [vid, hosts] of entries) next[vid] = hosts;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [watchedVaultIds, vaultCredHosts, managedApi]);

  // Compute MCP servers the agent uses but no selected vault has credentials for.
  // Empty when: no agent picked, or agent has no MCP servers, or every server
  // is covered by at least one selected vault. The proxy resolver matches by
  // hostname (not full URL), so we compare hostnames here.
  const unauthedMcpServers = useMemo(() => {
    if (agentMcpUrls.length === 0) return [];
    const coveredHosts = new Set<string>();
    for (const vid of watchedVaultIds) {
      const hosts = vaultCredHosts[vid];
      if (hosts) for (const h of hosts) coveredHosts.add(h);
    }
    const missing: Array<{ url: string; host: string }> = [];
    for (const url of agentMcpUrls) {
      let host: string;
      try { host = new URL(url).hostname; } catch { continue; }
      if (!coveredHosts.has(host)) missing.push({ url, host });
    }
    return missing;
  }, [agentMcpUrls, watchedVaultIds, vaultCredHosts]);

  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const [a, e, v, f, m] = await Promise.all([
        managedApi.agents.list({ limit: 200, include_archived: true }),
        managedApi.environments.list({ limit: 200 }),
        managedApi.vaults.list({ limit: 200 }).catch(() => ({ data: [], next_page: null })),
        managedApi.files.list({ limit: 200 }).catch(() => ({
          data: [], has_more: false, first_id: null, last_id: null,
        })),
        managedApi.memoryStores.list({ limit: 200 }).catch(() => ({ data: [], next_page: null })),
      ]);
      setAgents(a.data);
      setEnvs(e.data);
      setVaults(v.data);
      setFiles(f.data);
      setMemoryStores(m.data);
    } catch { /* surfaced by the api wrapper as a toast */ }
    setAuxLoading(false);
  };

  useEffect(() => { loadAux(); }, []);

  // Reset the form to its initial state and clear modal-scoped derived
  // state (agent detail / MCP URLs / vault cred cache / reveal toggles).
  // Called from Modal onClose (X button, click-away, Esc, Cancel).
  const closeModal = useCallback(() => {
    setShowCreate(false);
    reset(INITIAL_FORM_VALUES);
    setAgentMcpUrls([]);
    setVaultCredHosts({});
    setRevealedSecrets(new Set());
  }, [reset]);

  // Open the modal with sensible defaults populated. Reset first so any
  // residual state from a prior open (e.g. a successful create that closed
  // the modal) doesn't leak across opens.
  const openModal = useCallback(() => {
    reset({
      ...INITIAL_FORM_VALUES,
      agent: agents[0]?.id ?? "",
      environment_id: envs[0]?.id ?? "",
    });
    setAgentMcpUrls([]);
    setVaultCredHosts({});
    setRevealedSecrets(new Set());
    setShowCreate(true);
  }, [reset, agents, envs]);

  const onSubmit = async (data: FormValues) => {
    try {
      const resources: NonNullable<SessionCreateParams["resources"]> = [];
      for (const r of data.resources) {
        if (r.kind === "github") {
          // Token is required — schema gates the Create button on this,
          // but we double-check so a stale row from a previous validation
          // pass can't slip through.
          if (!r.url || !r.token) continue;
          const res: NonNullable<SessionCreateParams["resources"]>[number] = {
            type: "github_repository",
            url: r.url,
            authorization_token: r.token,
            // Always send mount_path: derive /workspace/<repo-name> from the
            // URL when the user left it blank. Mirrors the in-form preview.
            mount_path: r.mount_path || defaultMountPath(r.url),
          };
          if (r.checkout_type === "branch" && r.checkout_name) {
            res.checkout = { type: "branch", name: r.checkout_name };
          } else if (r.checkout_type === "commit" && r.checkout_name) {
            res.checkout = { type: "commit", sha: r.checkout_name };
          }
          resources.push(res);
        } else if (r.kind === "file") {
          if (!r.file_id) continue;
          const res: NonNullable<SessionCreateParams["resources"]>[number] = {
            type: "file",
            file_id: r.file_id,
          };
          if (r.mount_path) res.mount_path = r.mount_path;
          resources.push(res);
        } else if (r.kind === "memory_store") {
          if (!r.memory_store_id) continue;
          const res: NonNullable<SessionCreateParams["resources"]>[number] = {
            type: "memory_store",
            memory_store_id: r.memory_store_id,
            access: r.access,
          };
          resources.push(res);
        }
      }

      const body: SessionCreateParams = {
        agent: data.agent,
        environment_id: data.environment_id,
        title: data.title || undefined,
      };
      if (data.vault_ids.length > 0) body.vault_ids = data.vault_ids;
      if (resources.length > 0) body.resources = resources;

      const session = await managedApi.sessions.create(body);
      closeModal();
      nav(`/sessions/${session.id}`);
    } catch (err) {
      // 402 = no balance for cloud sandbox. Toast with the server's
      // "Insufficient balance" message has already shown; close the
      // modal and surface the Billing page so the user can top up
      // without hunting in the sidebar.
      if (err instanceof ApiError && err.status === 402) {
        closeModal();
        nav("/billing");
      }
      // Other failures: leave modal open so the user can adjust + retry.
    }
  };

  const toggleVault = (id: string) => {
    const current = getValues("vault_ids");
    const next = current.includes(id)
      ? current.filter((v) => v !== id)
      : [...current, id];
    setValue("vault_ids", next, { shouldValidate: true, shouldDirty: true });
  };

  const addResource = (kind: ResourceRow["kind"]) => {
    appendResource(blankResource(kind));
    setRevealedSecrets(new Set());
  };

  const removeResource = (idx: number) => {
    removeResourceAt(idx);
    setRevealedSecrets(new Set());
  };

  const statusCls = (status?: string) => {
    switch (status) {
      case "idle": return "bg-success-subtle text-success";
      case "running": return "bg-info-subtle text-info";
      default: return "bg-bg-surface text-fg-muted";
    }
  };

  const displayed = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      `${session.title ?? ""}\n${session.id}`.toLocaleLowerCase().includes(needle),
    );
  }, [search, sessions]);

  // Active-filter chip displays — kept undefined when matching the
  // default so the chip reads "Status ▾" rather than "Status: All ▾".
  // The clear-X only renders when the chip is in non-default state.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  // Agent picker — preloaded options from the same /v1/agents fetch the
  // create-modal Combobox uses (aux loadAux above). Single-select via
  // FacetedFilter, server-side via `agent_id` query param.
  const agentOptions = useMemo(
    () =>
      agents.map((a) => ({
        value: a.id,
        label: `${a.name} (${a.id})`,
      })),
    [agents],
  );
  const agentDisplay = filterAgent
    ? agentOptions.find((o) => o.value === filterAgent)?.label ?? filterAgent
    : undefined;

  const filters = (
    <>
      <FilterChip
        label="Agent"
        active={!!filterAgent}
        display={agentDisplay}
        onClear={() => setFilterAgent("")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-72 p-0"
        >
          <FacetedFilter
            options={agentOptions}
            value={filterAgent}
            onValueChange={(v) => setFilterAgent(v)}
            searchPlaceholder="Agent..."
          />
        </PopoverContent>
      </FilterChip>

      <FilterChip
        label="Status"
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-48 p-0"
        >
          <FacetedFilter
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder="Status..."
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  // First github row index + total count, computed once per render so the
  // "primary" pill on the first GitHub row stays in sync with reorders.
  // The proxy resolver uses the first declared github_repository's token
  // for any request whose URL doesn't carry an owner/repo slug (graphql,
  // /user, /search, …). Only show the hint when there are 2+ github
  // resources — for a single repo the "first" semantics aren't meaningful.
  const githubIdxs = resourceFields
    .map((r, i) => (r.kind === "github" ? i : -1))
    .filter((i) => i >= 0);
  const firstGithubIdx = githubIdxs[0] ?? -1;
  const showPrimaryHint = githubIdxs.length > 1;

  // Show validation errors only after the field has been touched (or after
  // submit), so the form doesn't render with errors visible on first open.
  const showError = (touched: boolean | undefined, msg: string | undefined) =>
    msg && (touched || formState.isSubmitted) ? msg : undefined;

  // Resource row error / touched lookups. The schema's discriminated union
  // means TypeScript narrows `formState.errors.resources[i]` to the
  // intersection of all variants — i.e. nothing — so accessing per-kind
  // fields like `.url` requires a runtime-friendly cast. Same for
  // touchedFields. Both helpers return undefined when nothing matches so
  // callers can compose with `showError` cleanly.
  const resourceFieldError = (idx: number, key: string): string | undefined => {
    const row = formState.errors.resources?.[idx] as
      | Record<string, { message?: string } | undefined>
      | undefined;
    return row?.[key]?.message;
  };
  const resourceFieldTouched = (idx: number, key: string): boolean => {
    const row = formState.touchedFields.resources?.[idx] as
      | Record<string, boolean | undefined>
      | undefined;
    return !!row?.[key];
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end
  // up with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Session>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "name",
        accessorFn: (s) => s.title ?? "",
        header: "Name",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 font-medium text-fg">
            {row.original.title || "Untitled"}
            <LinearBadge metadata={row.original.metadata} />
            <SlackBadge metadata={row.original.metadata} />
            <EvalBadge metadata={row.original.metadata} />
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "status",
        accessorFn: (s) => s.status ?? "idle",
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(row.original.status)}`}
          >
            {row.original.status || "idle"}
          </span>
        ),
      },
      {
        id: "agent",
        accessorFn: (s) => s.agent.id,
        header: "Agent",
        cell: ({ row }) => (
          <span className="text-fg-muted font-mono text-xs">{row.original.agent.id}</span>
        ),
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [refreshSessions],
  );

  const hasActiveFilter = !!search || !!filterAgent || status !== "any" || created.after !== undefined || created.before !== undefined;

  return (
    <DataTable<Session>
      createLabel="+ New session"
      onCreate={openModal}
      searchPlaceholder="Search sessions..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={displayed}
      loading={loading}
      getRowId={(s) => s.id}
      onRowClick={(s) => nav(`/sessions/${s.id}`)}
      rowActions={(session) => {
        const archived = Boolean(session.archived_at);
        const label = session.title?.trim() || session.id;
        return [
          {
            label: archived ? "Unarchive" : "Archive",
            icon: <ArchiveIcon className="size-4" />,
            disabled: archived,
            onSelect: async () => {
              try {
                await managedApi.sessions.archive(session.id);
                refreshSessions();
              } catch {}
            },
          },
          {
            label: "Delete",
            icon: <TrashIcon className="size-4" />,
            destructive: true,
            onSelect: async () => {
              if (!confirm(`Delete session "${label}"? This can't be undone.`)) return;
              try {
                await managedApi.sessions.delete(session.id);
                refreshSessions();
              } catch {}
            },
          },
        ];
      }}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={hasActiveFilter ? "No matching sessions" : "No sessions yet"}
      emptyKind="session"
      emptyAction={!hasActiveFilter && (
        <Button onClick={openModal}>+ New session</Button>
      )}
      emptySubtitle={
        hasActiveFilter
          ? "Try different filters."
          : "Sessions will appear here once created through the API."
      }
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={closeModal}
        title="New Session"
        subtitle="Start a conversation with an agent."
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button
              onClick={handleSubmit(onSubmit)}
              disabled={!formState.isValid || formState.isSubmitting}
              loading={formState.isSubmitting}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm text-fg-muted">Agent</Label>
              <a href="/agents" className="text-xs text-brand hover:underline">Manage agents →</a>
            </div>
            <Controller
              control={control}
              name="agent"
              render={({ field, fieldState }) => (
                <>
                  <Combobox<AgentLite>
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                    }}
                    endpoint="/v1/agents"
                    getValue={(a) => a.id}
                    getLabel={(a) => (
                      <span>
                        {a.name} <span className="text-fg-subtle text-sm">({a.id})</span>
                      </span>
                    )}
                    getTextLabel={(a) => `${a.name} (${a.id})`}
                    placeholder="Select agent..."
                  />
                  {showError(fieldState.isTouched, fieldState.error?.message) && (
                    <p className="text-xs text-danger mt-1">{fieldState.error?.message}</p>
                  )}
                </>
              )}
            />
          </div>
          <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-sm text-fg-muted">Environment</Label>
                <a href="/environments" className="text-xs text-brand hover:underline">Manage environments →</a>
              </div>
              <Controller
                control={control}
                name="environment_id"
                render={({ field, fieldState }) => (
                  <>
                    <Combobox<{ id: string; name: string }>
                      value={field.value}
                      onValueChange={(v) => field.onChange(v)}
                      endpoint="/v1/environments"
                      getValue={(e) => e.id}
                      getLabel={(e) => (
                        <span>
                          {e.name} <span className="text-fg-subtle text-sm">({e.id})</span>
                        </span>
                      )}
                      getTextLabel={(e) => `${e.name} (${e.id})`}
                      placeholder="Select environment..."
                    />
                    {showError(fieldState.isTouched, fieldState.error?.message) && (
                      <p className="text-xs text-danger mt-1">{fieldState.error?.message}</p>
                    )}
                  </>
                )}
              />
          </div>
          <div>
            <Label htmlFor="session-title" className="text-sm text-fg-muted block mb-1">Title <span className="text-fg-subtle">(optional)</span></Label>
            {/* autoComplete=off + an unrecognised name to defeat Chrome /
                Safari email autofill — first text input in the dialog
                got pre-filled with the user's saved email otherwise.
                Spread register() first, then override name so the input
                renders the autofill-defeating attribute while RHF still
                tracks the field by its registered name internally. */}
            <Input
              id="session-title"
              {...register("title")}
              name="oma-session-title"
              className={inputCls}
              placeholder="My conversation"
              autoComplete="off"
            />
          </div>

          {vaults.length > 0 && (
            <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm text-fg-muted">Credential Vaults <span className="text-fg-subtle">(optional)</span></Label>
              <a href="/vaults" className="text-xs text-brand hover:underline">Manage vaults →</a>
            </div>
              <div className="space-y-1">
                {vaults.map((v) => (
                  <Label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={watchedVaultIds.includes(v.id)}
                      onCheckedChange={() => toggleVault(v.id)}
                    />
                    <span className="text-fg">{v.display_name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{v.id}</span>
                  </Label>
                ))}
              </div>
              {unauthedMcpServers.length > 0 && (
                <div className="mt-2 px-3 py-2 rounded-md border border-warning/40 bg-warning/5 text-xs text-warning">
                  <div className="font-medium mb-1">
                    {unauthedMcpServers.length === 1
                      ? "1 MCP server has no matching credential in selected vaults:"
                      : `${unauthedMcpServers.length} MCP servers have no matching credentials in selected vaults:`}
                  </div>
                  <ul className="space-y-0.5 font-mono">
                    {unauthedMcpServers.map((s) => (
                      <li key={s.url}>· {s.host}</li>
                    ))}
                  </ul>
                  <div className="mt-1 text-fg-muted font-sans">
                    Agent will dial these endpoints unauthenticated. Add a vault credential for each, or expect the agent to see 401s mid-conversation.
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-sm text-fg-muted">Resources <span className="text-fg-subtle">(optional)</span></Label>
            </div>
            <p className="text-xs text-fg-subtle mb-2">
              Mount files, GitHub repositories, memory stores, or pass environment variables into the session.
            </p>
            {resourceFields.length === 0 ? (
              <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-3 text-center">
                No resources added.
              </div>
            ) : (
              <div className="space-y-2">
                {resourceFields.map((field, i) => {
                  // Live values for the current row — register() drives
                  // input state, but conditional rendering (kind-specific
                  // blocks, mount-path placeholder, reveal toggles) reads
                  // the watched copy so changes reflect immediately.
                  const live = watchedResources[i];
                  if (!live) return null;
                  return (
                    <div key={field.id} className="border border-border rounded-lg bg-bg-surface p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-fg inline-flex items-center gap-2">
                          {kindLabel(live.kind)}
                          {showPrimaryHint && live.kind === "github" && i === firstGithubIdx && (
                            <span
                              className="text-xs font-medium px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30 text-brand"
                              title="This repo's token is used for GitHub API calls that don't target a specific repo (GraphQL, Search, /user, …)"
                            >
                              primary
                            </span>
                          )}
                        </span>
                        <Button variant="ghost"
                          type="button"
                          onClick={() => removeResource(i)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger text-xs"
                          aria-label="Remove resource"
                        >
                          Remove
                        </Button>
                      </div>
                      {live.kind === "github" && (
                        <div className="space-y-2">
                          <div>
                            <Label htmlFor={`session-resource-${i}-url`} className="text-xs text-fg-muted block mb-0.5">Repository URL <span className="text-danger">*</span></Label>
                            <Input
                              id={`session-resource-${i}-url`}
                              {...register(`resources.${i}.url`)}
                              className={inputCls}
                              placeholder="https://github.com/owner/repo"
                            />
                            {showError(
                              resourceFieldTouched(i, "url"),
                              resourceFieldError(i, "url"),
                            ) && (
                              <p className="text-xs text-danger mt-1">
                                {resourceFieldError(i, "url")}
                              </p>
                            )}
                          </div>
                          <div>
                            <Label htmlFor={`session-resource-${i}-token`} className="text-xs text-fg-muted block mb-0.5">
                              Authorization Token <span className="text-danger">*</span>
                            </Label>
                            <div className="relative">
                              <Input
                                id={`session-resource-${i}-token`}
                                type={revealedSecrets.has(`${i}:token`) ? "text" : "password"}
                                {...register(`resources.${i}.token`)}
                                className={`${inputCls} pr-12`}
                                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                              />
                              {live.token && (
                                <Button variant="ghost"
                                  type="button"
                                  onClick={() => toggleReveal(`${i}:token`)}
                                  className="absolute inset-y-0 right-2 my-auto inline-flex h-fit items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-1 text-xs text-fg-subtle hover:text-fg"
                                  aria-label="Toggle token visibility"
                                >
                                  {revealedSecrets.has(`${i}:token`) ? "hide" : "show"}
                                </Button>
                              )}
                            </div>
                            {showError(
                              resourceFieldTouched(i, "token"),
                              resourceFieldError(i, "token"),
                            ) && (
                              <p className="text-xs text-danger mt-1">
                                {resourceFieldError(i, "token")}
                              </p>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label htmlFor={`session-resource-${i}-checkout-type`} className="text-xs text-fg-muted block mb-0.5">Checkout</Label>
                              <Select
                                id={`session-resource-${i}-checkout-type`}
                                name={`resources.${i}.checkout_type`}
                                value={live.checkout_type}
                                onValueChange={(value) => {
                                  setValue(
                                    `resources.${i}.checkout_type`,
                                    value as "none" | "branch" | "commit",
                                    { shouldDirty: true, shouldTouch: true, shouldValidate: true },
                                  );
                                  // Switching the checkout kind clears the
                                  // companion name so the placeholder hint
                                  // doesn't lie about commit-vs-branch.
                                  setValue(`resources.${i}.checkout_name`, "");
                                }}
                                className={inputCls}
                              >
                                <SelectOption value="none">None</SelectOption>
                                <SelectOption value="branch">Branch</SelectOption>
                                <SelectOption value="commit">Commit</SelectOption>
                              </Select>
                            </div>
                            <div>
                              <Label htmlFor={`session-resource-${i}-checkout-name`} className="text-xs text-fg-muted block mb-0.5">
                                {live.checkout_type === "commit" ? "Commit SHA" : "Name"}
                              </Label>
                              <Input
                                id={`session-resource-${i}-checkout-name`}
                                {...register(`resources.${i}.checkout_name`)}
                                className={inputCls}
                                disabled={live.checkout_type === "none"}
                                placeholder={live.checkout_type === "commit" ? "abc123..." : "main"}
                              />
                            </div>
                          </div>
                          <div>
                            <Label htmlFor={`session-resource-${i}-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></Label>
                            <Input
                              id={`session-resource-${i}-mount`}
                              {...register(`resources.${i}.mount_path`)}
                              className={inputCls}
                              placeholder={`${defaultMountPath(live.url)} (default)`}
                            />
                          </div>
                        </div>
                      )}
                      {live.kind === "file" && (
                        <div className="space-y-2">
                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <Label htmlFor={`session-resource-${i}-file`} className="text-xs text-fg-muted">File <span className="text-danger">*</span></Label>
                              <a href="/files" className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline">Manage files →</a>
                            </div>
                            <Select
                              id={`session-resource-${i}-file`}
                              name={`resources.${i}.file_id`}
                              value={live.file_id}
                              onValueChange={(value) =>
                                setValue(`resources.${i}.file_id`, value, {
                                  shouldDirty: true,
                                  shouldTouch: true,
                                  shouldValidate: true,
                                })
                              }
                              placeholder="Select file..."
                              className={inputCls}
                            >
                              {files.map((f) => (
                                <SelectOption key={f.id} value={f.id}>
                                  {f.filename} ({f.id})
                                </SelectOption>
                              ))}
                            </Select>
                            {files.length === 0 && (
                              <p className="text-xs text-fg-subtle mt-1">No files yet — upload via the AMA SDK or POST /v1/files.</p>
                            )}
                          </div>
                          <div>
                            <Label htmlFor={`session-resource-${i}-file-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></Label>
                            <Input
                              id={`session-resource-${i}-file-mount`}
                              {...register(`resources.${i}.mount_path`)}
                              className={inputCls}
                              placeholder="/mnt/session/uploads/<file_id> (default)"
                            />
                          </div>
                        </div>
                      )}
                      {live.kind === "memory_store" && (
                        <div className="space-y-2">
                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <Label htmlFor={`session-resource-${i}-store`} className="text-xs text-fg-muted">Store <span className="text-danger">*</span></Label>
                              <a href="/memory" className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline">Manage stores →</a>
                            </div>
                            <Select
                              id={`session-resource-${i}-store`}
                              name={`resources.${i}.memory_store_id`}
                              value={live.memory_store_id}
                              onValueChange={(value) =>
                                setValue(`resources.${i}.memory_store_id`, value, {
                                  shouldDirty: true,
                                  shouldTouch: true,
                                  shouldValidate: true,
                                })
                              }
                              placeholder="Select store..."
                              className={inputCls}
                            >
                              {memoryStores.map((m) => (
                                <SelectOption key={m.id} value={m.id}>
                                  {m.name} ({m.id})
                                </SelectOption>
                              ))}
                            </Select>
                          </div>
                          <div>
                            <Label htmlFor={`session-resource-${i}-access`} className="text-xs text-fg-muted block mb-0.5">Access</Label>
                            <Select
                              id={`session-resource-${i}-access`}
                              name={`resources.${i}.access`}
                              value={live.access}
                              onValueChange={(value) =>
                                setValue(
                                  `resources.${i}.access`,
                                  value as "read_write" | "read_only",
                                  { shouldDirty: true, shouldTouch: true, shouldValidate: true },
                                )
                              }
                              className={inputCls}
                            >
                              <SelectOption value="read_write">Read / Write</SelectOption>
                              <SelectOption value="read_only">Read only</SelectOption>
                            </Select>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              <Button variant="ghost" type="button" onClick={() => addResource("github")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ GitHub repo</Button>
              <Button variant="ghost" type="button" onClick={() => addResource("file")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ File</Button>
              <Button variant="ghost" type="button" onClick={() => addResource("memory_store")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ Memory store</Button>
            </div>
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}
