// Node crash-recovery integration test.
//
// Spawns the real main-node binary in a child process, drives it through
// HTTP to the point where a turn is in flight, kills the process with
// SIGKILL (matches fly auto_stop / k8s SIGKILL / docker OOM semantics —
// no graceful shutdown, in-memory state lost), then restarts the binary
// and asserts the bootstrap path recovers cleanly.
//
// The fidelity matters: SIGKILL drops the process between syscalls. No
// finally blocks run, no SQL UPDATEs land late, no graceful unwind. This
// is the actual condition the unified RuntimeAdapter has to survive in
// production. Unit-level adapter.test.ts proves the SQL invariants
// hold; this proves the bootstrap path stitches them back together
// after a real process death.
//
// What this test does NOT cover (separate suites):
//   - LLM call mid-stream: the test inserts the orphan turn marker
//     directly into SQL (no Anthropic key needed) so it runs in CI
//     deterministically. A separate live-LLM e2e is for staging.
//   - DO eviction: lives under apps/agent / test/integration/recovery-do.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import Database from "better-sqlite3";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

// Set DEBUG_CRASH_RECOVERY=1 to forward main-node's stdout/stderr to
// vitest's console live (helpful when iterating on the test).
const DEBUG = process.env.DEBUG_CRASH_RECOVERY === "1";

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
// Resolve tsx binary directly — `node --import tsx/esm` requires tsx to
// be resolvable from CWD's node_modules, which fails when the spawned
// child runs with `cwd: REPO_ROOT` but tsx is hoisted to a different
// node_modules layout. Pointing at the binary by absolute path is the
// most portable fix.
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

async function startMainNode(opts: { dataDir: string }): Promise<ProcessHandle> {
  // Run the real binary via tsx (same toolchain `pnpm start` uses).
  // ANTHROPIC_API_KEY is intentionally unset — we never trigger a real
  // turn here; the test injects the orphan row directly.
  //
  // Pick a fresh port per spawn — TIME_WAIT after SIGKILL holds the
  // previous port for ~60s, so reusing it across kill/restart inside the
  // same test is flaky. Different port + same dataDir is fine: state is
  // in sqlite, not the listener.
  const port = await pickPort();
  const child = spawn(
    TSX_BIN,
    [MAIN_NODE_ENTRY],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: join(opts.dataDir, "oma.db"),
        AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
        SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
        MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
        AUTH_DISABLED: "1",
        BETTER_AUTH_SECRET: "test-secret-only-for-vitest-do-not-deploy",
        // Quiet — too much log noise in test output otherwise.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Buffer logs in case a test fails — print them on demand. We don't
  // fail the test if main-node logs warnings; only health/HTTP probes
  // determine readiness.
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => {
    const s = b.toString();
    logBuf.push(s);
    if (DEBUG) process.stdout.write(`[main-node:${port}] ${s}`);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = b.toString();
    logBuf.push(s);
    if (DEBUG) process.stderr.write(`[main-node:${port}] ${s}`);
  });

  // Wait for /health to respond.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        // Bootstrap runs *after* /health starts answering on some boot
        // orderings; give it a beat to drain orphan recovery before the
        // test reads SQL. ~250ms is enough for a few-row scan; if the
        // recovery is still in flight by then the test's readiness
        // assertion will fail loudly anyway.
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch {
      // not ready yet
    }
    await sleep(200);
  }
  // Timeout — print buffered logs to help debug.
  // eslint-disable-next-line no-console
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickPort(): Promise<number> {
  // Ask the OS for an unused port. Avoids EADDRINUSE flakes from random
  // collisions or TIME_WAIT after a SIGKILLed previous run on the same
  // port. (Brief race: another process *could* grab it between this
  // close() and the spawned main-node's listen() — vanishingly unlikely
  // on CI.)
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        rej(new Error("could not pick port"));
      }
    });
  });
}

describe("main-node crash recovery (real process, SIGKILL)", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* leftover sockets etc */
    }
  });

  it("orphan session marked status='running' at SIGKILL is recovered to 'idle' on restart", async () => {
    // 1. First process boot — create the schema by letting main-node
    //    bootstrap, then immediately use sqlite to inject a session row
    //    that looks like a crashed in-flight turn.
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      // Seed: AUTH_DISABLED mode means tenant_id is the literal string
      // "default"; agents/sessions are scoped to that.
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, turn_id, turn_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "sess_orphan",
        "default",
        null,
        "running", // ← simulated crashed-mid-turn marker
        "turn_dead",
        now - 60_000,
        now - 60_000,
        now - 60_000,
      );
      db.close();
    }
    // 2. SIGKILL — no graceful shutdown. The process can't even flush
    //    its own state. Mirrors fly machine-stop / OOM kill.
    await killHard(h);
    h = null;

    // 3. Restart: this is the path that exercises the bootstrap
    //    recovery hook (registry.bootstrap → machine.onWake →
    //    listOrphanTurns + recoverInterruptedState + endTurn).
    h = await startMainNode({ dataDir });

    // 4. Assert the row got reconciled.
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT status, turn_id, turn_started_at FROM sessions WHERE id = ?`,
      )
      .get("sess_orphan") as
      | { status: string; turn_id: string | null; turn_started_at: number | null }
      | undefined;
    db.close();
    if (row?.status !== "idle") {
      // Surface the spawned process logs so debugging the bootstrap
      // path doesn't require re-running with DEBUG_CRASH_RECOVERY=1.
      // eslint-disable-next-line no-console
      console.error("main-node logs:\n" + h.logBuf.join(""));
    }
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
    expect(row?.turn_started_at).toBeNull();
  });

  it("multiple orphan sessions all get reconciled in one bootstrap pass", async () => {
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, turn_id, turn_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < 3; i++) {
        insert.run(
          `sess_orphan_${i}`,
          "default",
          null,
          "running",
          `turn_dead_${i}`,
          now - 60_000,
          now - 60_000,
          now - 60_000,
        );
      }
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const stillRunning = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'`)
      .get() as { n: number };
    db.close();
    if (stillRunning.n !== 0) {
      // eslint-disable-next-line no-console
      console.error("main-node logs:\n" + h.logBuf.join(""));
    }
    expect(stillRunning.n).toBe(0);
  });

  it("idle session at SIGKILL stays idle after restart (no false positive)", async () => {
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      // Seed a clean idle session — no turn_id, no recovery needed.
      db.prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sess_clean", "default", null, "idle", now, now);
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT status, turn_id FROM sessions WHERE id = ?`)
      .get("sess_clean") as { status: string; turn_id: string | null };
    db.close();
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
  });

  // ─── crash points with realistic in-flight state ─────────────────────
  //
  // The tests above only seed the sessions row. Real production crashes
  // also leave behind partial event-log + stream-table state. These
  // tests seed that state directly and assert the recovery path
  // (recoverInterruptedState inside machine.onWake) finalizes/injects
  // the right placeholders so the next user.message sees a clean
  // tool-use bijection + stream-status pair.

  it("crash with stuck stream → recovery finalizes it as 'interrupted' + appends agent.message with buffered chunks", async () => {
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      seedOrphanSession(db, "sess_streaming", "turn_streaming", now);
      // Stream row in 'streaming' status with two buffered chunks
      // simulates a process death mid-LLM.
      db.prepare(
        `INSERT INTO session_streams
           (session_id, message_id, status, chunks_json, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "sess_streaming",
        "msg_partial",
        "streaming",
        JSON.stringify(["Hello, ", "world"]),
        now - 30_000,
      );
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const sessRow = db
      .prepare(`SELECT status, turn_id FROM sessions WHERE id = ?`)
      .get("sess_streaming") as { status: string; turn_id: string | null };
    const streamRow = db
      .prepare(
        `SELECT status, chunks_json FROM session_streams WHERE session_id=? AND message_id=?`,
      )
      .get("sess_streaming", "msg_partial") as { status: string; chunks_json: string };
    const events = db
      .prepare(
        `SELECT type, data FROM session_events WHERE session_id=? ORDER BY seq`,
      )
      .all("sess_streaming") as Array<{ type: string; data: string }>;
    db.close();

    if (sessRow.status !== "idle") {
      // eslint-disable-next-line no-console
      console.error("main-node logs:\n" + h.logBuf.join(""));
    }

    expect(sessRow.status).toBe("idle");
    expect(sessRow.turn_id).toBeNull();
    expect(streamRow.status).toBe("interrupted");
    // recovery appended one synthetic agent.message carrying the joined chunks.
    const synthesised = events.find((e) => e.type === "agent.message");
    expect(synthesised).toBeDefined();
    const parsed = JSON.parse(synthesised!.data) as {
      message_id: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(parsed.message_id).toBe("msg_partial");
    expect(parsed.content[0].text).toBe("Hello, world");
  });

  it("crash with orphan agent.tool_use → recovery injects placeholder agent.tool_result so next LLM call doesn't 400", async () => {
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      seedOrphanSession(db, "sess_tool_orphan", "turn_tool", now);
      // event log: single agent.tool_use with no matching tool_result.
      // Anthropic strictly rejects an unmatched tool_use on the next
      // turn — recovery's job is to inject a placeholder.
      seedEvent(db, "sess_tool_orphan", 1, {
        type: "agent.tool_use",
        id: "use_dangling",
        name: "bash",
        input: { command: "echo hi" },
      });
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const sessRow = db
      .prepare(`SELECT status, turn_id FROM sessions WHERE id = ?`)
      .get("sess_tool_orphan") as { status: string; turn_id: string | null };
    const events = db
      .prepare(
        `SELECT type, data FROM session_events WHERE session_id=? ORDER BY seq`,
      )
      .all("sess_tool_orphan") as Array<{ type: string; data: string }>;
    db.close();

    if (sessRow.status !== "idle") {
      // eslint-disable-next-line no-console
      console.error("main-node logs:\n" + h.logBuf.join(""));
    }

    expect(sessRow.status).toBe("idle");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("agent.tool_use");
    expect(events[1].type).toBe("agent.tool_result");
    const result = JSON.parse(events[1].data) as {
      tool_use_id: string;
      content: string;
    };
    expect(result.tool_use_id).toBe("use_dangling");
    expect(result.content).toMatch(/interrupted/i);
  });

  it("crash with orphan agent.mcp_tool_use → recovery injects placeholder mcp_tool_result with is_error=true", async () => {
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      seedOrphanSession(db, "sess_mcp_orphan", "turn_mcp", now);
      seedEvent(db, "sess_mcp_orphan", 1, {
        type: "agent.mcp_tool_use",
        id: "mcp_dangling",
        name: "search",
        server_name: "tavily",
        input: { q: "anthropic" },
      });
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const events = db
      .prepare(
        `SELECT type, data FROM session_events WHERE session_id=? ORDER BY seq`,
      )
      .all("sess_mcp_orphan") as Array<{ type: string; data: string }>;
    db.close();

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("agent.mcp_tool_result");
    const result = JSON.parse(events[1].data) as {
      mcp_tool_use_id: string;
      is_error: boolean;
    };
    expect(result.mcp_tool_use_id).toBe("mcp_dangling");
    expect(result.is_error).toBe(true);
  });

  it("crash with orphan agent.custom_tool_use → row reconciled but NO event injected (user-driven)", async () => {
    // Session row should still flip to idle, but recovery must NOT
    // fabricate a user.custom_tool_result — that's user-driven (the SDK
    // confirms the tool's outcome). The orphan stands alone with a
    // warning-only signal.
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      seedOrphanSession(db, "sess_custom_orphan", "turn_custom", now);
      seedEvent(db, "sess_custom_orphan", 1, {
        type: "agent.custom_tool_use",
        id: "custom_dangling",
        name: "approve_purchase",
        input: { amount: 99.99 },
      });
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const sessRow = db
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get("sess_custom_orphan") as { status: string };
    const events = db
      .prepare(
        `SELECT type FROM session_events WHERE session_id=? ORDER BY seq`,
      )
      .all("sess_custom_orphan") as Array<{ type: string }>;
    db.close();

    expect(sessRow.status).toBe("idle");
    // Only the original event remains — no user.custom_tool_result auto-injected.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent.custom_tool_use");
  });

  it("crash with stale orphan (turn_started_at 24h ago) is still recovered (no time-based cutoff)", async () => {
    // No max-age filter on listOrphanTurns — once status='running' is
    // seen, recovery runs regardless of how long ago the turn started.
    // This pins the contract; if we ever add a stale-turn purge, it
    // should be a separate code path (e.g. periodic GC), not a guard
    // that hides genuine orphans.
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      seedOrphanSession(db, "sess_ancient", "turn_ancient", dayAgo);
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT status, turn_id FROM sessions WHERE id = ?`)
      .get("sess_ancient") as { status: string; turn_id: string | null };
    db.close();
    expect(row.status).toBe("idle");
    expect(row.turn_id).toBeNull();
  });

  it("mixed-state bootstrap: clean idle + orphan stream + orphan tool_use + clean session — all handled correctly", async () => {
    // Reality check: production data won't be uniform. Bootstrap must
    // cope with a mix of states without leaving any session stuck.
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      // Clean idle — no recovery needed.
      db.prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sess_clean", "default", null, "idle", now, now);
      // Orphan with stuck stream.
      seedOrphanSession(db, "sess_stream", "turn_stream", now);
      db.prepare(
        `INSERT INTO session_streams
           (session_id, message_id, status, chunks_json, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("sess_stream", "msg_x", "streaming", JSON.stringify(["partial"]), now);
      // Orphan with dangling tool_use.
      seedOrphanSession(db, "sess_tool", "turn_tool", now);
      seedEvent(db, "sess_tool", 1, {
        type: "agent.tool_use",
        id: "u_x",
        name: "bash",
      });
      // Another clean idle.
      db.prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sess_clean2", "default", null, "idle", now, now);
      db.close();
    }
    await killHard(h);
    h = null;

    h = await startMainNode({ dataDir });

    const db = new Database(dbPath, { readonly: true });
    const stillRunning = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status='running'`)
      .get() as { n: number };
    const streamRow = db
      .prepare(
        `SELECT status FROM session_streams WHERE session_id=? AND message_id=?`,
      )
      .get("sess_stream", "msg_x") as { status: string };
    const toolEvents = db
      .prepare(
        `SELECT type FROM session_events WHERE session_id=? ORDER BY seq`,
      )
      .all("sess_tool") as Array<{ type: string }>;
    db.close();

    expect(stillRunning.n).toBe(0);
    expect(streamRow.status).toBe("interrupted");
    // Original tool_use + injected tool_result.
    expect(toolEvents.map((e) => e.type)).toEqual([
      "agent.tool_use",
      "agent.tool_result",
    ]);
  });

  it("double crash: orphan recovered, then SIGKILL during normal idle, then restart — second restart finds nothing to recover", async () => {
    // Sanity check: the bootstrap path must converge. After the first
    // recovery, restarting again should be a clean idle boot (no rows
    // in 'running'). Catches a hypothetical bug where recovery leaves
    // status='running' when it injects events.
    h = await startMainNode({ dataDir });
    const dbPath = join(dataDir, "oma.db");
    {
      const db = new Database(dbPath);
      const now = Date.now();
      seedOrphanSession(db, "sess_d1", "turn_d1", now);
      seedEvent(db, "sess_d1", 1, {
        type: "agent.tool_use",
        id: "u_d1",
        name: "bash",
      });
      db.close();
    }
    await killHard(h);
    h = null;

    // First restart — recovers the orphan.
    h = await startMainNode({ dataDir });
    {
      const db = new Database(dbPath, { readonly: true });
      const r = db
        .prepare(`SELECT status FROM sessions WHERE id=?`)
        .get("sess_d1") as { status: string };
      db.close();
      expect(r.status).toBe("idle");
    }

    // Crash again. No orphan this time; just normal kill.
    await killHard(h);
    h = null;

    // Second restart — bootstrap should find zero orphans.
    h = await startMainNode({ dataDir });
    const db = new Database(dbPath, { readonly: true });
    const stillRunning = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status='running'`)
      .get() as { n: number };
    const events = db
      .prepare(`SELECT type FROM session_events WHERE session_id=? ORDER BY seq`)
      .all("sess_d1") as Array<{ type: string }>;
    db.close();
    expect(stillRunning.n).toBe(0);
    // No second tool_result injected on the second restart — recovery
    // is idempotent, the matched tool_use/tool_result pair stays as is.
    expect(events.map((e) => e.type)).toEqual([
      "agent.tool_use",
      "agent.tool_result",
    ]);
  });
});

// ── seed helpers ─────────────────────────────────────────────────────

function seedOrphanSession(
  db: Database.Database,
  sessionId: string,
  turnId: string,
  startedAt: number,
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, tenant_id, agent_id, status, turn_id, turn_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionId, "default", null, "running", turnId, startedAt, startedAt, startedAt);
}

function seedEvent(
  db: Database.Database,
  sessionId: string,
  seq: number,
  event: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO session_events (session_id, seq, type, data, ts)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, seq, event.type as string, JSON.stringify(event), Date.now());
}
