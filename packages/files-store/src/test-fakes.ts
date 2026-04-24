// In-memory implementations of every port for unit tests. Mirrors the
// cascade-on-delete behavior + ordering of the D1 adapter so tests catch
// the same integrity violations.

import type {
  Clock,
  FileListOptions,
  FileRepo,
  Logger,
  NewFileInput,
} from "./ports";
import { FileService } from "./service";
import type { FileRow, FileScope } from "./types";

interface InMemFile {
  id: string;
  tenant_id: string;
  session_id: string | null;
  scope: FileScope;
  filename: string;
  media_type: string;
  size_bytes: number;
  downloadable: boolean;
  r2_key: string;
  created_at: number;
}

export class InMemoryFileRepo implements FileRepo {
  private readonly byId = new Map<string, InMemFile>();

  async insert(input: NewFileInput): Promise<FileRow> {
    const row: InMemFile = {
      id: input.id,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      scope: input.scope,
      filename: input.filename,
      media_type: input.mediaType,
      size_bytes: input.sizeBytes,
      downloadable: input.downloadable,
      r2_key: input.r2Key,
      created_at: input.createdAt,
    };
    this.byId.set(input.id, row);
    return toRow(row);
  }

  async get(tenantId: string, fileId: string): Promise<FileRow | null> {
    const row = this.byId.get(fileId);
    if (!row || row.tenant_id !== tenantId) return null;
    return toRow(row);
  }

  async list(tenantId: string, opts: FileListOptions): Promise<FileRow[]> {
    let rows = Array.from(this.byId.values()).filter(
      (f) => f.tenant_id === tenantId,
    );
    if (opts.sessionId !== undefined) {
      rows = rows.filter((f) => f.session_id === opts.sessionId);
    }
    if (opts.beforeId) rows = rows.filter((f) => f.id < opts.beforeId!);
    if (opts.afterId) rows = rows.filter((f) => f.id > opts.afterId!);
    rows.sort((a, b) => {
      const cmp = a.created_at - b.created_at;
      return opts.order === "asc" ? cmp : -cmp;
    });
    return rows.slice(0, opts.limit).map(toRow);
  }

  async delete(tenantId: string, fileId: string): Promise<FileRow | null> {
    const row = this.byId.get(fileId);
    if (!row || row.tenant_id !== tenantId) return null;
    this.byId.delete(fileId);
    return toRow(row);
  }

  async deleteBySession(sessionId: string): Promise<FileRow[]> {
    const out: FileRow[] = [];
    for (const [id, row] of this.byId.entries()) {
      if (row.session_id === sessionId) {
        out.push(toRow(row));
        this.byId.delete(id);
      }
    }
    return out;
  }
}

export class ManualClock implements Clock {
  constructor(private ms: number = 0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
}

/**
 * Convenience factory — full in-memory wiring with sane defaults. Tests can
 * pass overrides for any port (e.g. a ManualClock for deterministic timestamps).
 */
export function createInMemoryFileService(opts?: {
  clock?: Clock;
  logger?: Logger;
}): {
  service: FileService;
  repo: InMemoryFileRepo;
} {
  const repo = new InMemoryFileRepo();
  const service = new FileService({
    repo,
    clock: opts?.clock,
    logger: opts?.logger ?? new SilentLogger(),
  });
  return { service, repo };
}

// ── helpers ──

function toRow(f: InMemFile): FileRow {
  return {
    id: f.id,
    tenant_id: f.tenant_id,
    session_id: f.session_id,
    scope: f.scope,
    filename: f.filename,
    media_type: f.media_type,
    size_bytes: f.size_bytes,
    downloadable: f.downloadable,
    r2_key: f.r2_key,
    created_at: msToIso(f.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
