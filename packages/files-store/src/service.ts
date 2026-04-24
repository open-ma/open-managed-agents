import { FileNotFoundError } from "./errors";
import type {
  Clock,
  FileListOptions,
  FileRepo,
  Logger,
  NewFileInput,
} from "./ports";
import {
  DEFAULT_LIST_LIMIT,
  FileRow,
  MAX_LIST_LIMIT,
} from "./types";

export interface FileServiceDeps {
  repo: FileRepo;
  clock?: Clock;
  logger?: Logger;
}

/**
 * FileService — pure business logic over abstract ports.
 *
 * Owns:
 *   - scope derivation (sessionId present → "session" scope, else "tenant")
 *   - list-path index selection (with vs without session filter)
 *   - delete returns r2_key so the route can DELETE the R2 object
 *   - cascade by session — single indexed query replaces the audit-flagged
 *     filebyscope: O(N) KV scan in files.ts:108-114
 *
 * Does NOT own:
 *   - id generation. Caller pre-allocates with `generateFileId()` from
 *     @open-managed-agents/shared so the route can compute the R2 key,
 *     PUT the blob, and only THEN call `create`. Keeps the failure semantics
 *     (R2 PUT before metadata write) identical to the KV era.
 *   - R2 PUT / GET / DELETE. The route owns R2 lifecycle. Service exposes
 *     r2_key on read + on delete so the route knows which object to act on.
 *   - Tenant-validation of session_id. The route already verifies the session
 *     belongs to the tenant (or doesn't, depending on the source). This store
 *     trusts the caller's tenantId argument.
 */
export class FileService {
  private readonly repo: FileRepo;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(deps: FileServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? defaultClock;
    this.logger = deps.logger ?? consoleLogger;
  }

  // ============================================================
  // Write paths
  // ============================================================

  /**
   * Insert file metadata. Caller has already PUT the blob to R2 under r2Key —
   * if this insert fails, the route is responsible for cleaning up the R2
   * object (or accepting the orphan, same as the KV-era behavior).
   *
   * `sessionId` controls scope:
   *   - undefined / null → scope = "tenant", session_id = NULL
   *   - string           → scope = "session", session_id = string
   */
  async create(opts: {
    id: string;
    tenantId: string;
    sessionId?: string | null;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    r2Key: string;
    downloadable?: boolean;
  }): Promise<FileRow> {
    const sessionId = opts.sessionId ?? null;
    const input: NewFileInput = {
      id: opts.id,
      tenantId: opts.tenantId,
      sessionId,
      scope: sessionId === null ? "tenant" : "session",
      filename: opts.filename,
      mediaType: opts.mediaType,
      sizeBytes: opts.sizeBytes,
      downloadable: opts.downloadable === true,
      r2Key: opts.r2Key,
      createdAt: this.clock.nowMs(),
    };
    // Explicit `await` so an immediately-rejecting insert is caught here and
    // becomes this function's rejection — without it, V8 transiently marks
    // the inner Promise as unhandled before the outer await catches it.
    return await this.repo.insert(input);
  }

  /**
   * Hard-delete a file's metadata. Returns the deleted row so the caller can
   * pull `r2_key` out and DELETE the R2 object. Throws FileNotFoundError if
   * the file doesn't exist (matches the route's 404 response).
   */
  async delete(opts: {
    tenantId: string;
    fileId: string;
  }): Promise<FileRow> {
    const deleted = await this.repo.delete(opts.tenantId, opts.fileId);
    if (!deleted) throw new FileNotFoundError();
    return deleted;
  }

  /**
   * Cascade-delete every file scoped to a session. Returns the deleted rows
   * so the caller can DELETE each from R2. Currently no caller — the
   * session-delete route does NOT cascade scoped files (potential leak
   * tracked in OPE follow-ups). Exposed here so the integration step or a
   * future cleanup job can call it without needing more service surface.
   */
  async deleteBySession(opts: {
    sessionId: string;
  }): Promise<FileRow[]> {
    return this.repo.deleteBySession(opts.sessionId);
  }

  // ============================================================
  // Read paths
  // ============================================================

  async get(opts: {
    tenantId: string;
    fileId: string;
  }): Promise<FileRow | null> {
    return this.repo.get(opts.tenantId, opts.fileId);
  }

  /**
   * List files for a tenant, with optional session filter + cursor pagination.
   * Defaults: limit=100, max=1000, order=desc — matches files.ts:101-103.
   *
   * The session filter uses the (tenant_id, session_id, created_at DESC)
   * composite index. Without it, uses (tenant_id, created_at DESC). Both
   * paths are a single indexed SELECT — the KV-era list+merge is gone.
   */
  async list(opts: {
    tenantId: string;
    sessionId?: string;
    beforeId?: string;
    afterId?: string;
    order?: "asc" | "desc";
    limit?: number;
  }): Promise<FileRow[]> {
    let limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIST_LIMIT;
    if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;
    const listOpts: FileListOptions = {
      sessionId: opts.sessionId,
      beforeId: opts.beforeId,
      afterId: opts.afterId,
      order: opts.order ?? "desc",
      limit,
    };
    return this.repo.list(opts.tenantId, listOpts);
  }
}

// ============================================================
// Default infra
// ============================================================

const defaultClock: Clock = { nowMs: () => Date.now() };

const consoleLogger: Logger = { warn: (msg, ctx) => console.warn(msg, ctx) };
