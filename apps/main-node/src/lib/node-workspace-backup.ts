// NodeWorkspaceBackupService — tar+upload workspace snapshots to a
// BlobStore on demand, restore on cold start. Backs the
// SandboxOrchestrator's snapshot/restore for providers that don't ship
// native CF-style createBackup (everything except CloudflareSandbox).
//
// Strategy:
//   - Snapshot: spawn `tar -C <workdir> -cf - .` under the sandbox's
//     readFileBytes path; pipe to a tar.zst-compressed buffer; upload to
//     BlobStore key `workspace-backups/<tenant>/<sessionId>/<ts>.tar.zst`.
//     For LocalSubprocess this means tar-ing the workdir directly on
//     the host — bypasses the SandboxExecutor port for speed/efficiency.
//     For LiteBox / Daytona / E2B / BoxRun, drive tar through the
//     sandbox's exec primitive and round-trip via readFileBytes.
//   - Restore: download the tar from BlobStore, write to a temp file,
//     drive tar -xf inside the sandbox via exec.
//
// Persistence: every snapshot inserts a `workspace_backups` row keyed by
// session_id; restore picks the most recent unexpired row.
//
// Best-effort throughout: any provider where tar+exec fails returns
// ok=false and the orchestrator proceeds with an empty workspace.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type {
  OrchestratorBackupHandle,
  WorkspaceBackupService,
} from "@open-managed-agents/sandbox/orchestrator";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { getLogger } from "@open-managed-agents/observability";

const moduleLogger = getLogger("node-workspace-backup");

export interface NodeWorkspaceBackupServiceDeps {
  sql: SqlClient;
  blobs: BlobStore;
  /** TTL on snapshots — rows older than this are GC-eligible (cron not
   *  yet wired; kept as metadata for the GC pass to use). */
  ttlSec?: number;
  /** Optional logger. */
  logger?: { warn(msg: string, ctx?: unknown): void; log(msg: string): void };
  /** Optional clock for tests. */
  nowMs?: () => number;
}

const DEFAULT_TTL_SEC = 7 * 24 * 3600;

export class NodeWorkspaceBackupService implements WorkspaceBackupService {
  private readonly ttlSec: number;
  private readonly logger: NonNullable<NodeWorkspaceBackupServiceDeps["logger"]>;
  private readonly nowMs: () => number;

  constructor(private deps: NodeWorkspaceBackupServiceDeps) {
    this.ttlSec = deps.ttlSec ?? DEFAULT_TTL_SEC;
    this.logger = deps.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async snapshot(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
  }): Promise<OrchestratorBackupHandle | null> {
    const tarBytes = await this.tarWorkspace(input.sandbox);
    if (!tarBytes) return null;
    const id = `wsb_${randomBytes(8).toString("hex")}`;
    const blobKey = `workspace-backups/${input.tenantId}/${input.sessionId}/${id}.tar`;
    await this.deps.blobs.put(blobKey, tarBytes, {
      httpMetadata: { contentType: "application/x-tar" },
      customMetadata: {
        tenant_id: input.tenantId,
        session_id: input.sessionId,
      },
    });
    const now = this.nowMs();
    await this.deps.sql
      .prepare(
        `INSERT INTO workspace_backups (id, tenant_id, session_id, blob_key, size_bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.sessionId,
        blobKey,
        tarBytes.byteLength,
        now,
        now + this.ttlSec * 1000,
      )
      .run();
    this.logger.log(
      `snapshot session=${input.sessionId.slice(0, 12)} bytes=${tarBytes.byteLength}`,
    );
    return { id, dir: blobKey };
  }

  async restore(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
    handle: OrchestratorBackupHandle;
  }): Promise<{ ok: boolean; error?: string }> {
    const blobKey = input.handle.dir ?? "";
    if (!blobKey) return { ok: false, error: "no blob_key on handle" };
    const obj = await this.deps.blobs.get(blobKey);
    if (!obj) return { ok: false, error: "backup blob missing" };
    const bytes = await obj.bytes();
    return this.untarIntoSandbox(input.sandbox, bytes);
  }

  async latest(input: {
    sessionId: string;
    tenantId: string;
  }): Promise<OrchestratorBackupHandle | null> {
    const now = this.nowMs();
    const row = await this.deps.sql
      .prepare(
        `SELECT id, blob_key FROM workspace_backups
         WHERE session_id = ? AND tenant_id = ? AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(input.sessionId, input.tenantId, now)
      .first<{ id: string; blob_key: string }>();
    return row ? { id: row.id, dir: row.blob_key } : null;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  /** tar the sandbox's /workspace into bytes. Best-effort: returns null on
   *  any failure (caller treats as "no backup", proceeds). */
  private async tarWorkspace(sandbox: SandboxExecutor): Promise<Uint8Array | null> {
    const tmpInside = `/tmp/oma-ws-${randomBytes(6).toString("hex")}.tar`;
    const out = await sandbox.exec(
      `cd /workspace 2>/dev/null && tar -cf '${tmpInside}' --exclude='./node_modules' --exclude='./.cache' --exclude='./__pycache__' --exclude='./.next' . 2>&1 || echo '[exit 1]'`,
      120_000,
    );
    if (out.includes("[exit ")) {
      this.logger.warn(`tarWorkspace tar failed: ${out.slice(0, 200)}`);
      return null;
    }
    if (!sandbox.readFileBytes) {
      this.logger.warn("tarWorkspace: sandbox missing readFileBytes; skipping");
      return null;
    }
    try {
      return await sandbox.readFileBytes(tmpInside);
    } catch (err) {
      this.logger.warn(`tarWorkspace read failed: ${(err as Error).message}`);
      return null;
    } finally {
      // Best-effort cleanup of the tar inside the sandbox.
      void sandbox.exec(`rm -f '${tmpInside}'`, 5_000).catch(() => undefined);
    }
  }

  private async untarIntoSandbox(
    sandbox: SandboxExecutor,
    tarBytes: Uint8Array,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!sandbox.writeFileBytes) {
      return { ok: false, error: "sandbox missing writeFileBytes" };
    }
    const tmpHost = join(tmpdir(), `oma-ws-restore-${randomBytes(6).toString("hex")}.tar`);
    await fs.writeFile(tmpHost, tarBytes);
    const tmpInside = `/tmp/oma-ws-restore-${randomBytes(6).toString("hex")}.tar`;
    try {
      await sandbox.writeFileBytes(tmpInside, tarBytes);
      const out = await sandbox.exec(
        `mkdir -p /workspace && tar -xf '${tmpInside}' -C /workspace 2>&1 || echo '[exit 1]'`,
        120_000,
      );
      if (out.includes("[exit ")) {
        return { ok: false, error: `untar failed: ${out.slice(0, 200)}` };
      }
      return { ok: true };
    } finally {
      await fs.rm(tmpHost, { force: true }).catch(() => undefined);
      void sandbox.exec(`rm -f '${tmpInside}'`, 5_000).catch(() => undefined);
    }
  }
}
