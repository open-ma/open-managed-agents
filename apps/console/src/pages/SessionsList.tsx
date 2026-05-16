import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Controller, useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useApi } from "../lib/api";
import { usePagedList } from "../lib/usePagedList";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { Combobox } from "../components/Combobox";
import { ListPage } from "../components/ListPage";

interface Session {
  id: string; title?: string | null; agent: { id: string; version: number };
  environment_id: string;
  status?: string; created_at: string; archived_at?: string;
  metadata?: Record<string, unknown>;
}
interface Vault { id: string; name: string; }
interface FilePick { id: string; filename: string; size_bytes: number; }
interface MemoryStorePick { id: string; name: string; }

type AgentLite = {
  id: string;
  name: string;
  // Present iff the agent is bound to a user-registered runtime
  // (acp-proxy harness). The New Session dialog reads this to decide
  // whether to show the Environment picker — local-runtime sessions
  // don't run a sandbox container so there's nothing to pick.
  runtime_binding?: { runtime_id: string; acp_agent_id: string };
};

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
  mount_path: z.string(),
  access: z.enum(["read_write", "read_only"]),
});

const EnvResourceSchema = z.object({
  kind: z.literal("env"),
  name: z.string(),
  value: z.string(),
});

/** Discriminated union — `kind` selects which fields apply. Mapped to the
 *  wire `{type, ...}` resource object at submit time (see `onSubmit`). */
const ResourceSchema = z.discriminatedUnion("kind", [
  GithubResourceSchema,
  FileResourceSchema,
  MemoryStoreResourceSchema,
  EnvResourceSchema,
]);

/** Base form schema. `environment_id` is conditionally required at runtime
 *  (only when the picked agent is NOT a local-runtime agent) — see the
 *  superRefine wired up in the component, which reads a ref kept in sync
 *  with the live `isLocalRuntime` derivation. */
const FormSchema = z.object({
  agent: z.string().min(1, "Select an agent"),
  environment_id: z.string(),
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
    case "memory_store": return { kind, memory_store_id: "", mount_path: "", access: "read_write" };
    case "env": return { kind, name: "", value: "" };
  }
}

function kindLabel(kind: ResourceRow["kind"]): string {
  switch (kind) {
    case "github": return "GitHub repository";
    case "file": return "File";
    case "memory_store": return "Memory store";
    case "env": return "Environment variable";
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
function LinearBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const linear = metadata?.linear as
    | { issueIdentifier?: string; issueId?: string; workspaceId?: string }
    | undefined;
  if (!linear || (!linear.issueId && !linear.issueIdentifier)) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-info-subtle text-info"
      title={`Linear issue ${linear.issueIdentifier ?? linear.issueId}`}
    >
      🔗 {linear.issueIdentifier ?? "Linear"}
    </span>
  );
}

/** Tiny "💬 Slack" pill shown when a session was triggered by a Slack event. */
function SlackBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const slack = metadata?.slack as
    | { channelId?: string; threadTs?: string; workspaceId?: string }
    | undefined;
  if (!slack || (!slack.channelId && !slack.threadTs)) return null;
  const label = slack.channelId
    ? slack.channelId.startsWith("D")
      ? "DM"
      : slack.channelId
    : "Slack";
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-accent-violet-subtle text-accent-violet"
      title={`Slack channel ${slack.channelId}${slack.threadTs ? ` thread ${slack.threadTs}` : ""}`}
    >
      💬 {label}
    </span>
  );
}

/** Tiny "🧪 Eval" pill shown when a session was spawned by an eval-runner trial. */
function EvalBadge({ metadata }: { metadata?: Record<string, unknown> }) {
  const ev = metadata?.eval as { run_id?: string; task_id?: string } | undefined;
  if (!ev?.run_id) return null;
  return (
    <a
      href={`/evals/${ev.run_id}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-info-subtle text-info hover:opacity-80 transition-opacity"
      title={`Eval run ${ev.run_id}${ev.task_id ? ` · task ${ev.task_id}` : ""}`}
    >
      🧪 {ev.task_id ?? "Eval"}
    </a>
  );
}

export function SessionsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [agents, setAgents] = useState<AgentLite[]>([]);
  // Set by the agent Combobox when the user picks an agent. Carries the
  // full row so we can read `runtime_binding` without keeping every agent
  // preloaded in `agents[]`.
  const [selectedAgentDetail, setSelectedAgentDetail] = useState<AgentLite | null>(null);
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

  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState("");

  // Sessions table — cursor-paginated with proper Prev/Next/Page-N
  // pagination, server-side filtered by agent_id when the filter dropdown
  // is set. Filter change resets to page 1 (usePagedList re-fetches and
  // clears the cursor stack when params change).
  const sessionsParams = useMemo(
    () => ({ agent_id: filterAgent || undefined }),
    [filterAgent],
  );
  const {
    items: sessions,
    isLoading: loading,
    pageIndex,
    pageSize,
    hasNext,
    knownPages,
    goToPage,
    setPageSize,
    refresh: refreshSessions,
  } = usePagedList<Session>("/v1/sessions", { defaultPageSize: 20, params: sessionsParams });

  // ── Form (react-hook-form + zod) ──
  // The schema's `environment_id` requirement depends on whether the
  // currently picked agent is a local-runtime agent — a runtime fact the
  // schema can't see on its own. We close over a ref that the component
  // keeps in sync with the live `isLocalRuntime` derivation (see below).
  // Stable resolver = stable useForm config; we call `trigger()` from a
  // useEffect when isLocalRuntime flips to refresh the conditional error.
  const isLocalRuntimeRef = useRef(false);
  const resolver = useMemo(
    () =>
      // Cast addresses a workspace zod version skew: the resolver's bundled
      // .d.ts resolves `zod/v4/core` to the root install (currently 4.3.x,
      // version.minor=3) while console's own zod is 4.4.x (minor=4). Both
      // are wire-compatible at runtime; only the structural type guard on
      // _zod.version trips. No behavior change.
      zodResolver(
        FormSchema.superRefine((data, ctx) => {
          if (!isLocalRuntimeRef.current && !data.environment_id) {
            ctx.addIssue({
              code: "custom",
              path: ["environment_id"],
              message: "Select an environment",
            });
          }
        }) as never,
      ) as Resolver<FormValues>,
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
    trigger,
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
  // light row (id/name/runtime_binding); we need the full row to know
  // which MCP endpoints the agent will dial. Refetch on agent change;
  // clear on unselect.
  useEffect(() => {
    if (!watchedAgentId) {
      setAgentMcpUrls([]);
      return;
    }
    let cancelled = false;
    api<{ mcp_servers?: Array<{ url?: string }> }>(`/v1/agents/${watchedAgentId}`)
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
  }, [watchedAgentId, api]);

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
          const r = await api<{ data: Array<{ auth?: { mcp_server_url?: string } }> }>(
            `/v1/vaults/${vid}/credentials`,
          );
          const hosts = new Set<string>();
          for (const cred of r.data) {
            const u = cred.auth?.mcp_server_url;
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
  }, [watchedVaultIds, vaultCredHosts, api]);

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

  // Computed: which agent is selected, and is it bound to a local runtime?
  // The Environment picker, the schema's env_id requirement, and the
  // request body all key off this single source of truth.
  // Prefer the full row captured by the Combobox onValueChange callback,
  // but only when its id matches the form's current value (otherwise we'd
  // hold a stale row across resets / programmatic agent changes). Fall
  // back to the preloaded `agents` array, then to undefined while either
  // resolves.
  const selectedAgent = useMemo(() => {
    if (selectedAgentDetail && selectedAgentDetail.id === watchedAgentId) {
      return selectedAgentDetail;
    }
    return agents.find((a) => a.id === watchedAgentId);
  }, [selectedAgentDetail, agents, watchedAgentId]);
  const isLocalRuntime = !!selectedAgent?.runtime_binding;

  // Keep the resolver's closed-over ref aligned with the current render's
  // value, then trigger a revalidation pass so formState.isValid reflects
  // the new conditional rule immediately. Writing to a ref during render
  // is safe (React docs: refs don't drive renders).
  isLocalRuntimeRef.current = isLocalRuntime;
  useEffect(() => {
    void trigger();
  }, [isLocalRuntime, trigger]);

  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const [a, e, v, f, m] = await Promise.all([
        api<{ data: AgentLite[] }>("/v1/agents?limit=200"),
        api<{ data: Array<{ id: string; name: string }> }>("/v1/environments?limit=200"),
        api<{ data: Vault[] }>("/v1/vaults?limit=200").catch(() => ({ data: [] })),
        api<{ data: FilePick[] }>("/v1/files?limit=200").catch(() => ({ data: [] })),
        api<{ data: MemoryStorePick[] }>("/v1/memory_stores").catch(() => ({ data: [] })),
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
    setSelectedAgentDetail(null);
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
    setSelectedAgentDetail(null);
    setAgentMcpUrls([]);
    setVaultCredHosts({});
    setRevealedSecrets(new Set());
    setShowCreate(true);
  }, [reset, agents, envs]);

  const onSubmit = async (data: FormValues) => {
    try {
      const resources: Array<Record<string, unknown>> = [];
      for (const r of data.resources) {
        if (r.kind === "github") {
          // Token is required — schema gates the Create button on this,
          // but we double-check so a stale row from a previous validation
          // pass can't slip through.
          if (!r.url || !r.token) continue;
          const res: Record<string, unknown> = {
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
          const res: Record<string, unknown> = { type: "file", file_id: r.file_id };
          if (r.mount_path) res.mount_path = r.mount_path;
          resources.push(res);
        } else if (r.kind === "memory_store") {
          if (!r.memory_store_id) continue;
          const res: Record<string, unknown> = {
            type: "memory_store",
            memory_store_id: r.memory_store_id,
            access: r.access,
          };
          if (r.mount_path) res.mount_path = r.mount_path;
          resources.push(res);
        } else if (r.kind === "env") {
          if (!r.name || !r.value) continue;
          // type=env (was env_secret pre-rename). Server still accepts the
          // legacy alias so older console builds keep working — see
          // sessions.ts:262.
          resources.push({ type: "env", name: r.name, value: r.value });
        }
      }

      const body: Record<string, unknown> = {
        agent: data.agent,
        title: data.title || undefined,
      };
      // Only send environment_id when the user actually picked one. For
      // local-runtime agents the picker is hidden and the server picks a
      // tenant fallback (sessions.ts requires a NOT NULL env_id today).
      if (data.environment_id) body.environment_id = data.environment_id;
      if (data.vault_ids.length > 0) body.vault_ids = data.vault_ids;
      if (resources.length > 0) body.resources = resources;

      const session = await api<Session>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      closeModal();
      nav(`/sessions/${session.id}`);
    } catch (err) {
      // 402 = no balance for cloud sandbox. Toast with the server's
      // "Insufficient balance" message has already shown; close the
      // modal and surface the Billing page so the user can top up
      // without hunting in the sidebar.
      if ((err as { status?: number }).status === 402) {
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

  const displayed = sessions.filter((s) => {
    if (search && !s.id.toLowerCase().includes(search.toLowerCase()) && !(s.title || "").toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Compatibility shim: keep `load()` reference for any future caller.
  // Currently unused after refresh-on-create kicks off via refreshSessions.
  void refreshSessions;

  // Agent filter — Combobox over /v1/agents with server-side q + infinite
  // scroll. Empty `filterAgent` = unfiltered. Always render (Combobox
  // self-loads); a small × inside the trigger clears the filter.
  const agentFilter = (
    <div className="inline-flex items-center gap-1">
      <div className="w-56">
        <Combobox<{ id: string; name: string }>
          value={filterAgent}
          onValueChange={(v) => setFilterAgent(v)}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => a.name}
          getTextLabel={(a) => a.name}
          placeholder="Agent: All"
        />
      </div>
      {filterAgent && (
        <button
          type="button"
          onClick={() => setFilterAgent("")}
          aria-label="Clear agent filter"
          className="text-fg-subtle hover:text-fg text-xs inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 px-2 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        >
          ×
        </button>
      )}
    </div>
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

  return (
    <ListPage<Session>
      title="Sessions"
      subtitle="Trace and debug agent sessions."
      createLabel="+ New session"
      onCreate={openModal}
      searchPlaceholder="Go to session ID..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={agentFilter}
      data={displayed}
      loading={loading}
      getRowKey={(s) => s.id}
      onRowClick={(s) => nav(`/sessions/${s.id}`)}
      pageIndex={pageIndex}
      pageSize={pageSize}
      hasNext={hasNext}
      knownPages={knownPages}
      pageSizeOptions={[10, 20, 50, 100]}
      onPageChange={goToPage}
      onPageSizeChange={setPageSize}
      emptyTitle={search || filterAgent ? "No matching sessions" : "No sessions yet"}
      emptyKind="session"
      emptyAction={!search && !filterAgent && (
        <Button onClick={openModal}>+ New session</Button>
      )}
      emptySubtitle={
        search || filterAgent
          ? "Try different filters."
          : "Sessions will appear here once created through the API."
      }
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[180px]",
          render: (s) => <span title={s.id}>{s.id}</span>,
        },
        {
          key: "name",
          label: "Name",
          className: "font-medium text-fg",
          render: (s) => (
            <span className="inline-flex items-center gap-2">
              {s.title || "Untitled"}
              <LinearBadge metadata={s.metadata} />
              <SlackBadge metadata={s.metadata} />
              <EvalBadge metadata={s.metadata} />
            </span>
          ),
        },
        {
          key: "status",
          label: "Status",
          render: (s) => (
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(s.status)}`}>
              {s.status || "idle"}
            </span>
          ),
        },
        {
          key: "agent",
          label: "Agent",
          className: "text-fg-muted font-mono text-xs",
          render: (s) => s.agent.id,
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (s) => new Date(s.created_at).toLocaleDateString(),
        },
      ]}
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
              <label className="text-sm text-fg-muted">Agent</label>
              <a href="/agents" className="text-xs text-brand hover:underline">Manage agents →</a>
            </div>
            <Controller
              control={control}
              name="agent"
              render={({ field, fieldState }) => (
                <>
                  <Combobox<AgentLite>
                    value={field.value}
                    onValueChange={(v, item) => {
                      field.onChange(v);
                      if (item) setSelectedAgentDetail(item);
                    }}
                    endpoint="/v1/agents"
                    getValue={(a) => a.id}
                    getLabel={(a) => (
                      <span>
                        {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
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
          {/* Environment picker is for cloud sandbox lanes — local-runtime
              agents (acp-proxy harness) run on the user's daemon and
              never touch a cloud sandbox, so the picker is hidden in
              that mode. Server picks a tenant fallback when env_id is
              omitted; see sessions.ts:resolvedEnvId. */}
          {!isLocalRuntime && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm text-fg-muted">Environment</label>
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
                          {e.name} <span className="text-fg-subtle text-[12px]">({e.id})</span>
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
          )}
          {isLocalRuntime && (
            <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
              Local runtime agents use the runtime machine's filesystem — no cloud environment needed.
            </p>
          )}
          <div>
            <label htmlFor="session-title" className="text-sm text-fg-muted block mb-1">Title <span className="text-fg-subtle">(optional)</span></label>
            {/* autoComplete=off + an unrecognised name to defeat Chrome /
                Safari email autofill — first text input in the dialog
                got pre-filled with the user's saved email otherwise.
                Spread register() first, then override name so the input
                renders the autofill-defeating attribute while RHF still
                tracks the field by its registered name internally. */}
            <input
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
              <label className="text-sm text-fg-muted">Credential Vaults <span className="text-fg-subtle">(optional)</span></label>
              <a href="/vaults" className="text-xs text-brand hover:underline">Manage vaults →</a>
            </div>
              <div className="space-y-1">
                {vaults.map((v) => (
                  <label key={v.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={watchedVaultIds.includes(v.id)}
                      onChange={() => toggleVault(v.id)}
                      className="rounded accent-brand"
                    />
                    <span className="text-fg">{v.name}</span>
                    <span className="text-fg-subtle font-mono text-xs">{v.id}</span>
                  </label>
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
              <label className="text-sm text-fg-muted">Resources <span className="text-fg-subtle">(optional)</span></label>
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
                              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand/10 border border-brand/30 text-brand"
                              title="This repo's token is used for GitHub API calls that don't target a specific repo (GraphQL, Search, /user, …)"
                            >
                              primary
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeResource(i)}
                          className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger text-xs"
                          aria-label="Remove resource"
                        >
                          Remove
                        </button>
                      </div>
                      {live.kind === "github" && (
                        <div className="space-y-2">
                          <div>
                            <label htmlFor={`session-resource-${i}-url`} className="text-xs text-fg-muted block mb-0.5">Repository URL <span className="text-danger">*</span></label>
                            <input
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
                            <label htmlFor={`session-resource-${i}-token`} className="text-xs text-fg-muted block mb-0.5">
                              Authorization Token <span className="text-danger">*</span>
                            </label>
                            <div className="relative">
                              <input
                                id={`session-resource-${i}-token`}
                                type={revealedSecrets.has(`${i}:token`) ? "text" : "password"}
                                {...register(`resources.${i}.token`)}
                                className={`${inputCls} pr-12`}
                                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                              />
                              {live.token && (
                                <button
                                  type="button"
                                  onClick={() => toggleReveal(`${i}:token`)}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-1 text-xs text-fg-subtle hover:text-fg"
                                  aria-label="Toggle token visibility"
                                >
                                  {revealedSecrets.has(`${i}:token`) ? "hide" : "show"}
                                </button>
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
                              <label htmlFor={`session-resource-${i}-checkout-type`} className="text-xs text-fg-muted block mb-0.5">Checkout</label>
                              <select
                                id={`session-resource-${i}-checkout-type`}
                                {...register(`resources.${i}.checkout_type`, {
                                  // Switching the checkout kind clears the
                                  // companion name so the placeholder hint
                                  // doesn't lie about commit-vs-branch.
                                  onChange: () => setValue(`resources.${i}.checkout_name`, ""),
                                })}
                                className={inputCls}
                              >
                                <option value="none">None</option>
                                <option value="branch">Branch</option>
                                <option value="commit">Commit</option>
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`session-resource-${i}-checkout-name`} className="text-xs text-fg-muted block mb-0.5">
                                {live.checkout_type === "commit" ? "Commit SHA" : "Name"}
                              </label>
                              <input
                                id={`session-resource-${i}-checkout-name`}
                                {...register(`resources.${i}.checkout_name`)}
                                className={inputCls}
                                disabled={live.checkout_type === "none"}
                                placeholder={live.checkout_type === "commit" ? "abc123..." : "main"}
                              />
                            </div>
                          </div>
                          <div>
                            <label htmlFor={`session-resource-${i}-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                            <input
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
                              <label htmlFor={`session-resource-${i}-file`} className="text-xs text-fg-muted">File <span className="text-danger">*</span></label>
                              <a href="/files" className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline">Manage files →</a>
                            </div>
                            <select
                              id={`session-resource-${i}-file`}
                              {...register(`resources.${i}.file_id`)}
                              className={inputCls}
                            >
                              <option value="">Select file...</option>
                              {files.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.filename} ({f.id})
                                </option>
                              ))}
                            </select>
                            {files.length === 0 && (
                              <p className="text-xs text-fg-subtle mt-1">No files yet — upload via the AMA SDK or POST /v1/files.</p>
                            )}
                          </div>
                          <div>
                            <label htmlFor={`session-resource-${i}-file-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                            <input
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
                              <label htmlFor={`session-resource-${i}-store`} className="text-xs text-fg-muted">Store <span className="text-danger">*</span></label>
                              <a href="/memory" className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline">Manage stores →</a>
                            </div>
                            <select
                              id={`session-resource-${i}-store`}
                              {...register(`resources.${i}.memory_store_id`)}
                              className={inputCls}
                            >
                              <option value="">Select store...</option>
                              {memoryStores.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.name} ({m.id})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label htmlFor={`session-resource-${i}-access`} className="text-xs text-fg-muted block mb-0.5">Access</label>
                              <select
                                id={`session-resource-${i}-access`}
                                {...register(`resources.${i}.access`)}
                                className={inputCls}
                              >
                                <option value="read_write">Read / Write</option>
                                <option value="read_only">Read only</option>
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`session-resource-${i}-store-mount`} className="text-xs text-fg-muted block mb-0.5">Mount Path <span className="text-fg-subtle">(optional)</span></label>
                              <input
                                id={`session-resource-${i}-store-mount`}
                                {...register(`resources.${i}.mount_path`)}
                                className={inputCls}
                                placeholder="/mnt/memory/<name>/ (default)"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                      {live.kind === "env" && (
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label htmlFor={`session-resource-${i}-env-name`} className="text-xs text-fg-muted block mb-0.5">Name <span className="text-danger">*</span></label>
                            <input
                              id={`session-resource-${i}-env-name`}
                              {...register(`resources.${i}.name`)}
                              className={inputCls}
                              placeholder="ENV_VAR_NAME"
                            />
                          </div>
                          <div>
                            <label htmlFor={`session-resource-${i}-env-value`} className="text-xs text-fg-muted block mb-0.5">Value <span className="text-danger">*</span></label>
                            <div className="relative">
                              <input
                                id={`session-resource-${i}-env-value`}
                                type={revealedSecrets.has(`${i}:value`) ? "text" : "password"}
                                {...register(`resources.${i}.value`)}
                                className={`${inputCls} pr-12`}
                                placeholder="value"
                              />
                              {live.value && (
                                <button
                                  type="button"
                                  onClick={() => toggleReveal(`${i}:value`)}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-1 text-xs text-fg-subtle hover:text-fg"
                                  aria-label="Toggle value visibility"
                                >
                                  {revealedSecrets.has(`${i}:value`) ? "hide" : "show"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
              <button type="button" onClick={() => addResource("github")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ GitHub repo</button>
              <button type="button" onClick={() => addResource("file")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ File</button>
              <button type="button" onClick={() => addResource("memory_store")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ Memory store</button>
              <button type="button" onClick={() => addResource("env")} className="inline-flex items-center justify-center min-h-11 sm:min-h-0 text-xs px-2.5 py-1.5 border border-border rounded-md hover:bg-bg-surface text-fg-muted hover:text-fg">+ Env var</button>
            </div>
          </div>
        </div>
      </Modal>
    </ListPage>
  );
}
