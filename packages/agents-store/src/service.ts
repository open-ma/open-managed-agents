import { generateAgentId } from "@open-managed-agents/shared";
import { paginateVia } from "@open-managed-agents/shared";
import type { AgentConfig, ToolConfig } from "@open-managed-agents/shared";
import {
  AgentNotFoundError,
  AgentVersionMismatchError,
  AgentVersionNotFoundError,
} from "./errors";
import type {
  AgentRepo,
  AgentUpdateFields,
  Clock,
  IdGenerator,
  Logger,
} from "./ports";
import type { AgentRow, AgentVersionRow } from "./types";

export interface AgentServiceDeps {
  repo: AgentRepo;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/** Subset of AgentConfig fields callers may set on create. id + version +
 *  created_at + updated_at are stamped by the service. */
export interface NewAgentInput {
  name: string;
  model: AgentConfig["model"];
  system?: string;
  tools?: ToolConfig[];
  harness?: string;
  description?: string;
  mcp_servers?: AgentConfig["mcp_servers"];
  skills?: AgentConfig["skills"];
  callable_agents?: AgentConfig["callable_agents"];
  metadata?: Record<string, unknown>;
  aux_model?: AgentConfig["aux_model"];
  appendable_prompts?: string[];
  runtime_binding?: AgentConfig["runtime_binding"];
  enable_general_subagent?: boolean;
}

/** Mutable subset for `update`. Per-field `null` means "clear" — service
 *  reproduces the legacy semantics (system / description → empty string,
 *  optional refs → undefined). Pass `undefined` to leave a field untouched. */
export interface UpdateAgentInput {
  name?: string;
  model?: AgentConfig["model"];
  system?: string | null;
  tools?: ToolConfig[];
  harness?: string;
  description?: string | null;
  mcp_servers?: AgentConfig["mcp_servers"] | null;
  skills?: AgentConfig["skills"] | null;
  callable_agents?: AgentConfig["callable_agents"] | null;
  /** Per-key merge — pass `{ key: "" }` or `{ key: null }` to drop a key. */
  metadata?: Record<string, unknown>;
  aux_model?: AgentConfig["aux_model"] | null;
  appendable_prompts?: string[] | null;
  runtime_binding?: AgentConfig["runtime_binding"] | null;
  enable_general_subagent?: boolean | null;
}

/** Default tools value when none provided — matches agents.ts:125. */
const DEFAULT_TOOLS: ToolConfig[] = [{ type: "agent_toolset_20260401" }];

/** Field set the legacy update path inspects for change-detection — kept in
 *  sync with agents.ts:238. */
const UPDATABLE_FIELDS = [
  "name",
  "model",
  "system",
  "tools",
  "harness",
  "description",
  "mcp_servers",
  "skills",
  "callable_agents",
  "aux_model",
  "metadata",
  "appendable_prompts",
  "runtime_binding",
  "enable_general_subagent",
] as const;

/**
 * AgentService — pure business logic over abstract ports.
 *
 * Owns:
 *   - id generation + initial version stamp on create
 *   - field-level change detection on update (skip the version bump when
 *     nothing actually changed — was agents.ts:236-248)
 *   - optimistic-concurrency check via `expectedVersion` (was agents.ts:232)
 *   - history snapshot write before each update (was agents.ts:251)
 *   - metadata merge semantics on update (per-key delete on null/"")
 *   - listVersions / getVersion semantics — historical only, current lives
 *     in `agents` (matches legacy KV layout)
 *
 * Does NOT own:
 *   - model_card validation. Route layer (agents.ts:50-79 validateModel) still
 *     queries the model-cards service before calling create/update — that's a
 *     cross-service check we don't want to entangle in this port surface.
 *   - Cascade safety (refuse-delete on active sessions / eval runs). Route
 *     layer enumerates those via the sessions + evals services and decides
 *     whether to proceed.
 *   - formatAgent (API normalization). That's an HTTP-shape concern; the
 *     service returns the raw AgentConfig.
 */
export class AgentService {
  private readonly repo: AgentRepo;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: AgentServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  async create(opts: {
    tenantId: string;
    input: NewAgentInput;
  }): Promise<AgentRow> {
    const id = this.ids.agentId();
    const nowMs = this.clock.nowMs();
    const nowIso = msToIso(nowMs);

    const config: AgentConfig = {
      id,
      name: opts.input.name,
      model: opts.input.model,
      system: opts.input.system ?? "",
      tools: opts.input.tools ?? DEFAULT_TOOLS,
      harness: opts.input.harness,
      description: opts.input.description,
      mcp_servers: opts.input.mcp_servers,
      skills: opts.input.skills,
      callable_agents: opts.input.callable_agents,
      metadata: opts.input.metadata,
      aux_model: opts.input.aux_model,
      appendable_prompts: opts.input.appendable_prompts,
      runtime_binding: opts.input.runtime_binding,
      enable_general_subagent: opts.input.enable_general_subagent,
      version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    };

    return await this.repo.insert({
      id,
      tenantId: opts.tenantId,
      config,
      createdAt: nowMs,
    });
  }

  /**
   * Patch an agent. Returns the updated row (version bumped) or the unchanged
   * row when nothing actually changed (no version bump in that case — matches
   * agents.ts:246-248).
   *
   * Optimistic concurrency: pass `expectedVersion` to refuse the write if the
   * agent has been bumped under us. Mirrors agents.ts:232-234 (POST /v1/agents/:id).
   */
  async update(opts: {
    tenantId: string;
    agentId: string;
    input: UpdateAgentInput;
    /** When set, refuse if the current version doesn't match. Mirrors POST /v1/agents/:id ?version=. */
    expectedVersion?: number;
  }): Promise<AgentRow> {
    const existing = await this.requireAgent(opts);

    if (
      opts.expectedVersion !== undefined &&
      opts.expectedVersion !== existing.version
    ) {
      throw new AgentVersionMismatchError(opts.expectedVersion, existing.version);
    }

    // Detect field-level changes BEFORE building the new config — if nothing
    // moved, return the existing row unmodified to skip a version bump (mirrors
    // agents.ts:237-248 — "no-op update").
    const changed = this.detectChanges(existing, opts.input);
    if (!changed) return existing;

    const nextConfig = this.applyUpdate(existing, opts.input);
    nextConfig.version = existing.version + 1;
    nextConfig.updated_at = msToIso(this.clock.nowMs());

    return await this.repo.updateWithVersionSnapshot(
      opts.tenantId,
      opts.agentId,
      {
        config: nextConfig,
        version: nextConfig.version,
        updatedAt: this.clock.nowMs(),
      } satisfies AgentUpdateFields,
      {
        agentId: opts.agentId,
        tenantId: opts.tenantId,
        version: existing.version,
        snapshot: stripTenantId(existing),
        createdAt: this.clock.nowMs(),
      },
    );
  }

  async archive(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<AgentRow> {
    await this.requireAgent(opts);
    return this.repo.archive(opts.tenantId, opts.agentId, this.clock.nowMs());
  }

  /**
   * Hard-delete the agent AND cascade-delete its history rows in one batch.
   * Caller is responsible for: the active-sessions / active-evals safety
   * checks (those live in different services).
   */
  async delete(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<void> {
    await this.requireAgent(opts);
    await this.repo.deleteWithVersions(opts.tenantId, opts.agentId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<AgentRow | null> {
    return this.repo.get(opts.tenantId, opts.agentId);
  }

  /** Cross-tenant lookup by id — used by SessionDO's getAgentConfig fallback
   *  (session-do.ts:185). Trusts the caller to authorize since it has no
   *  tenant scope. */
  async getById(opts: { agentId: string }): Promise<AgentRow | null> {
    return this.repo.getById(opts.agentId);
  }

  async list(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<AgentRow[]> {
    return this.repo.list(opts.tenantId, {
      includeArchived: opts.includeArchived ?? true,
    });
  }

  /**
   * Paginated list — returns one page plus an opaque `nextCursor` when more
   * pages exist. Order: newest first (created_at DESC, id DESC tie-break).
   * Pass the previous response's `nextCursor` back as `cursor` to fetch the
   * next page; omit `cursor` for the first page.
   *
   * Cursor format is opaque on the wire (base64url(JSON({t,i}))) — callers
   * never need to interpret it. The route handler propagates it as-is.
   */
  async listPage(opts: {
    tenantId: string;
    includeArchived?: boolean;
    /** Hard-clamped to [1, 200]. */
    limit?: number;
    /** Opaque cursor returned by a prior call. Undefined = first page. */
    cursor?: string;
    /** Substring filter passed through to the repo. */
    q?: string;
  }): Promise<{ items: AgentRow[]; nextCursor?: string }> {
    return paginateVia({
      cursor: opts.cursor,
      limit: opts.limit,
      fetch: (after, limit) =>
        this.repo.listPage(opts.tenantId, {
          includeArchived: opts.includeArchived ?? true,
          limit,
          after,
          q: opts.q,
        }),
      extractCursor: (r) => ({ createdAt: isoToMs(r.created_at), id: r.id }),
    });
  }

  /** Cheap COUNT for /v1/stats. Default counts only non-archived rows
   *  (matches what the dashboard headline numbers represent). */
  async count(opts: {
    tenantId: string;
    includeArchived?: boolean;
  }): Promise<number> {
    return this.repo.count(opts.tenantId, {
      includeArchived: opts.includeArchived ?? false,
    });
  }

  // ============================================================
  // Version ops
  // ============================================================

  /** All historical snapshots for an agent (versions 1..current-1). Returns
   *  empty when the agent only has its initial version. The caller verifies
   *  the agent itself exists — the route layer's GET /:id/versions does that
   *  via its own existence check (agents.ts:286-287). */
  async listVersions(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<AgentVersionRow[]> {
    return this.repo.listVersions(opts.tenantId, opts.agentId);
  }

  /** A specific historical snapshot. Returns null for current-version lookups
   *  (which match legacy KV — `t:{t}:agent:{id}:v{current}` was never written). */
  async getVersion(opts: {
    tenantId: string;
    agentId: string;
    version: number;
  }): Promise<AgentVersionRow | null> {
    return this.repo.getVersion(opts.tenantId, opts.agentId, opts.version);
  }

  /** Like `getVersion` but throws when missing — convenience for handlers
   *  that prefer the typed-error shape. */
  async requireVersion(opts: {
    tenantId: string;
    agentId: string;
    version: number;
  }): Promise<AgentVersionRow> {
    const row = await this.repo.getVersion(opts.tenantId, opts.agentId, opts.version);
    if (!row) throw new AgentVersionNotFoundError();
    return row;
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireAgent(opts: {
    tenantId: string;
    agentId: string;
  }): Promise<AgentRow> {
    const row = await this.repo.get(opts.tenantId, opts.agentId);
    if (!row) throw new AgentNotFoundError();
    return row;
  }

  /** True if any of the updatable fields differ between existing + patch.
   *  Mirrors the legacy JSON.stringify diff at agents.ts:240-244 — same
   *  semantics, same edge cases (so a no-op metadata patch with the same
   *  keys still skips the version bump). */
  private detectChanges(existing: AgentRow, patch: UpdateAgentInput): boolean {
    for (const key of UPDATABLE_FIELDS) {
      const next = (patch as unknown as Record<string, unknown>)[key];
      if (next === undefined) continue;
      const current = (existing as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(next) !== JSON.stringify(current)) return true;
    }
    return false;
  }

  /** Apply patch fields onto a fresh copy of `existing` — does NOT bump
   *  version or updated_at (caller does that after the change check). */
  private applyUpdate(existing: AgentRow, patch: UpdateAgentInput): AgentConfig {
    // Strip tenant_id so we round-trip pure AgentConfig back to the repo.
    const next: AgentConfig = stripTenantId(existing);

    for (const key of UPDATABLE_FIELDS) {
      const value = (patch as unknown as Record<string, unknown>)[key];
      if (value === undefined) continue;

      if (value === null) {
        // Per legacy behavior (agents.ts:255-256): system/description clear
        // to "", everything else clears to undefined.
        if (key === "system" || key === "description") {
          (next as unknown as Record<string, unknown>)[key] = "";
        } else {
          (next as unknown as Record<string, unknown>)[key] = undefined;
        }
      } else if (key === "metadata" && typeof value === "object") {
        // Per-key merge — set "" or null on a key to delete it (agents.ts:258-267).
        const merged: Record<string, unknown> = { ...(existing.metadata ?? {}) };
        for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
          if (mv === "" || mv === null) {
            delete merged[mk];
          } else {
            merged[mk] = mv;
          }
        }
        next.metadata = merged;
      } else {
        (next as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return next;
  }
}

// ============================================================
// Helpers
// ============================================================

/** AgentRow is `AgentConfig & { tenant_id }` — pull tenant_id off when
 *  round-tripping back to a pure AgentConfig (e.g. for snapshot writes). */
function stripTenantId(row: AgentRow): AgentConfig {
  const { tenant_id: _t, ...rest } = row;
  return rest;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

// ============================================================
// Default infra (used when callers don't override)
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const defaultIds: IdGenerator = { agentId: generateAgentId };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
