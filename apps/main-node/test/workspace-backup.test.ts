// Unit tests for NodeWorkspaceBackupService — drives the snapshot/restore
// path against an in-memory blob store + sqlite. Verifies:
//
//   - snapshot tar's a workspace, uploads, inserts a row
//   - restore unpacks a snapshot back into a fresh sandbox
//   - latest() returns the most recent unexpired row, null otherwise
//
// Uses a fake SandboxExecutor that emulates exec/readFileBytes/writeFileBytes
// against a host tmp dir — no real subprocess, fast in CI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { applySchema } from "@open-managed-agents/schema";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeWorkspaceBackupService } from "../src/lib/node-workspace-backup.js";

class FakeSandbox implements SandboxExecutor {
  workdir: string;
  constructor() {
    this.workdir = join(tmpdir(), `oma-fake-${randomBytes(6).toString("hex")}`);
    mkdirSync(this.workdir, { recursive: true });
    mkdirSync(join(this.workdir, "workspace"), { recursive: true });
  }
  async exec(command: string, _timeout?: number): Promise<string> {
    // Run sh -c relative to <workdir>/workspace ... or /tmp emulated as
    // a workdir-relative subdir.
    const { spawnSync } = await import("node:child_process");
    // Map /tmp → workdir/.tmp + /workspace → workdir/workspace.
    const remapped = command
      .replace(/\/tmp\//g, `${this.workdir}/.tmp/`)
      .replace(/\/workspace\b/g, `${this.workdir}/workspace`);
    mkdirSync(join(this.workdir, ".tmp"), { recursive: true });
    const r = spawnSync("/bin/sh", ["-c", remapped]);
    const stdout = r.stdout?.toString() ?? "";
    const stderr = r.stderr?.toString() ?? "";
    const combined = stdout + (stderr ? `\n${stderr}` : "");
    return r.status === 0 ? combined.trim() : `${combined.trim()}\n[exit ${r.status}]`;
  }
  async readFile(path: string): Promise<string> {
    const buf = await fs.readFile(this.toHost(path));
    return buf.toString("utf8");
  }
  async readFileBytes(path: string): Promise<Uint8Array> {
    const buf = await fs.readFile(this.toHost(path));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async writeFile(path: string, content: string): Promise<string> {
    const host = this.toHost(path);
    await fs.mkdir(join(host, ".."), { recursive: true });
    await fs.writeFile(host, content);
    return path;
  }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const host = this.toHost(path);
    await fs.mkdir(join(host, ".."), { recursive: true });
    await fs.writeFile(host, bytes);
    return path;
  }
  async destroy(): Promise<void> {
    rmSync(this.workdir, { recursive: true, force: true });
  }
  private toHost(p: string): string {
    if (p.startsWith("/tmp/")) return join(this.workdir, ".tmp", p.slice("/tmp/".length));
    if (p.startsWith("/workspace/")) return join(this.workdir, "workspace", p.slice("/workspace/".length));
    if (p === "/workspace") return join(this.workdir, "workspace");
    return join(this.workdir, p);
  }
}

describe("NodeWorkspaceBackupService", () => {
  let dbPath: string;
  let sql: SqlClient;
  let blobs: InMemoryBlobStore;
  let svc: NodeWorkspaceBackupService;
  let sandbox: FakeSandbox;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `oma-wsb-${randomBytes(6).toString("hex")}.db`);
    sql = await createBetterSqlite3SqlClient(dbPath);
    await applySchema({ sql, dialect: "sqlite" });
    blobs = new InMemoryBlobStore();
    svc = new NodeWorkspaceBackupService({ sql, blobs });
    sandbox = new FakeSandbox();
  });

  afterEach(async () => {
    await sandbox.destroy().catch(() => {});
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  });

  it("snapshot tars a workspace and inserts a row; restore unpacks it back", async () => {
    // Seed the workspace.
    await sandbox.writeFile("/workspace/hello.txt", "world");
    await sandbox.writeFile("/workspace/sub/deep.txt", "nested");

    const handle = await svc.snapshot({
      sessionId: "sess_1",
      tenantId: "tn_1",
      sandbox,
    });
    expect(handle).not.toBeNull();
    expect(handle!.id).toMatch(/^wsb_/);
    expect(handle!.dir).toContain("workspace-backups/tn_1/sess_1/");

    // Row landed in workspace_backups.
    const r = await sql
      .prepare(`SELECT id, blob_key, size_bytes FROM workspace_backups WHERE session_id = ?`)
      .bind("sess_1")
      .first<{ id: string; blob_key: string; size_bytes: number }>();
    expect(r).not.toBeNull();
    expect(r!.size_bytes).toBeGreaterThan(0);

    // latest() returns it.
    const latest = await svc.latest({ sessionId: "sess_1", tenantId: "tn_1" });
    expect(latest?.id).toBe(handle!.id);

    // Restore into a fresh sandbox.
    const fresh = new FakeSandbox();
    const restored = await svc.restore({
      sessionId: "sess_1",
      tenantId: "tn_1",
      sandbox: fresh,
      handle: handle!,
    });
    expect(restored.ok).toBe(true);
    expect(await fresh.readFile("/workspace/hello.txt")).toBe("world");
    expect(await fresh.readFile("/workspace/sub/deep.txt")).toBe("nested");
    await fresh.destroy();
  });

  it("latest() returns null when no backups exist", async () => {
    const r = await svc.latest({ sessionId: "sess_none", tenantId: "tn_1" });
    expect(r).toBeNull();
  });
});
