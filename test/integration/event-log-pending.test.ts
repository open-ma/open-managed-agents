// @ts-nocheck
//
// Integration tests for the AMA-shaped event-log pending lifecycle.
// Reaches into a live SessionDO via runInDurableObject so the schema
// migration (ALTER TABLE ADD COLUMN + backfill) runs against real
// workerd SQLite, not a test-local mock.
//
// Coverage:
//   1. ensureSchema migrates v1 → v2 (no processed_at column → has all
//      three new columns, with legacy rows back-filled to "processed").
//   2. CfDoEventLog.append stamps user.* events with processed_at=NULL
//      (pending) and other types with processed_at=ts (already-ingested).
//   3. The partial pending-index returns events in seq order, scoped to
//      session_thread_id.
//   4. user.interrupt-style UPDATE flushes pending user.* events for a
//      thread; siblings (other thread, or already-processed) are
//      untouched.
//   5. eventsToMessages skips cancelled rows when re-read via getEvents.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  CfDoEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/cf-do";
import { eventsToMessages } from "../../apps/agent/src/runtime/history";

function stamp(e: any): void {
  if (!e.id) e.id = `sevt_${Math.random().toString(36).slice(2, 14)}`;
  if (!e.processed_at) e.processed_at = new Date().toISOString();
}

function freshDoStub(idHint: string) {
  const id = `${idHint}_${Math.random().toString(36).slice(2, 10)}`;
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
}

describe("event-log pending lifecycle", () => {
  it("ensureSchema migrates legacy events table (v1 → v2)", async () => {
    const stub = freshDoStub("pending_migration");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      // Drop fresh schema, recreate v1-only (no new columns) + seed
      // legacy rows. This simulates an existing prod DO that has the
      // old schema before the deploy.
      sql.exec(`DROP TABLE IF EXISTS events`);
      sql.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
        )
      `);
      sql.exec(
        `INSERT INTO events (type, data) VALUES (?, ?)`,
        "user.message",
        '{"type":"user.message","content":[{"type":"text","text":"old1"}]}',
      );
      sql.exec(
        `INSERT INTO events (type, data) VALUES (?, ?)`,
        "agent.message",
        '{"type":"agent.message","content":[{"type":"text","text":"reply1"}]}',
      );
      // Now run the new ensureSchema — must add columns + backfill.
      ensureEventLogSchema(sql);

      const cols: string[] = [];
      for (const row of sql.exec(`PRAGMA table_info(events)`)) {
        cols.push(row.name as string);
      }
      expect(cols).toEqual(
        expect.arrayContaining(["processed_at", "cancelled_at", "session_thread_id"]),
      );

      // Legacy rows: processed_at should be filled (= ts) so the new
      // pending-index never picks them up; session_thread_id =
      // 'sthr_primary'.
      const rows: any[] = [];
      for (const row of sql.exec(
        `SELECT seq, type, processed_at, cancelled_at, session_thread_id FROM events ORDER BY seq`,
      )) {
        rows.push(row);
      }
      expect(rows).toHaveLength(2);
      expect(rows[0].processed_at).not.toBeNull();
      expect(rows[1].processed_at).not.toBeNull();
      expect(rows[0].cancelled_at).toBeNull();
      expect(rows[0].session_thread_id).toBe("sthr_primary");
      expect(rows[1].session_thread_id).toBe("sthr_primary");
    });
  });

  it("append stamps user.* as pending, agent.* as processed", async () => {
    const stub = freshDoStub("pending_append");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      log.append({ type: "user.message", content: [{ type: "text", text: "hi" }] } as any);
      log.append({ type: "agent.message", content: [{ type: "text", text: "yo" }] } as any);
      log.append({
        type: "user.tool_confirmation",
        tool_use_id: "tu_1",
        result: "allow",
      } as any);

      const rows: any[] = [];
      for (const row of sql.exec(
        `SELECT type, processed_at FROM events ORDER BY seq`,
      )) {
        rows.push(row);
      }
      expect(rows[0].type).toBe("user.message");
      expect(rows[0].processed_at).toBeNull(); // pending
      expect(rows[1].type).toBe("agent.message");
      expect(rows[1].processed_at).not.toBeNull(); // immediate
      expect(rows[2].type).toBe("user.tool_confirmation");
      expect(rows[2].processed_at).toBeNull(); // pending
    });
  });

  it("partial pending-index returns events ordered by seq, scoped to thread", async () => {
    const stub = freshDoStub("pending_lookup");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      // Five user.message on primary, two on a sub-agent thread.
      for (let i = 1; i <= 5; i++) {
        log.append({
          type: "user.message",
          content: [{ type: "text", text: `primary ${i}` }],
        } as any);
      }
      log.append({
        type: "user.message",
        session_thread_id: "sthr_subagentA",
        content: [{ type: "text", text: "sub 1" }],
      } as any);
      log.append({
        type: "user.message",
        session_thread_id: "sthr_subagentA",
        content: [{ type: "text", text: "sub 2" }],
      } as any);

      // Hot-path query: lowest pending seq for primary.
      function nextPending(threadId: string) {
        for (const row of sql.exec(
          `SELECT seq, data FROM events
             WHERE session_thread_id = ?
               AND processed_at IS NULL AND cancelled_at IS NULL
               AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')
             ORDER BY seq ASC LIMIT 1`,
          threadId,
        )) {
          return { seq: row.seq as number, data: row.data as string };
        }
        return null;
      }

      const p0 = nextPending("sthr_primary");
      expect(p0).not.toBeNull();
      expect(JSON.parse(p0!.data).content[0].text).toBe("primary 1");

      const sub0 = nextPending("sthr_subagentA");
      expect(sub0).not.toBeNull();
      expect(JSON.parse(sub0!.data).content[0].text).toBe("sub 1");

      // Mark primary 1 as processed → next call returns primary 2.
      sql.exec(
        `UPDATE events SET processed_at = ? WHERE seq = ?`,
        Date.now(), p0!.seq,
      );
      const p1 = nextPending("sthr_primary");
      expect(JSON.parse(p1!.data).content[0].text).toBe("primary 2");

      // Subagent thread untouched.
      const sub1 = nextPending("sthr_subagentA");
      expect(JSON.parse(sub1!.data).content[0].text).toBe("sub 1");
    });
  });

  it("user.interrupt UPDATE flushes only the target thread", async () => {
    const stub = freshDoStub("pending_interrupt");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      // 3 pending on primary, 2 on subagent.
      for (let i = 1; i <= 3; i++) {
        log.append({
          type: "user.message",
          content: [{ type: "text", text: `primary ${i}` }],
        } as any);
      }
      for (let i = 1; i <= 2; i++) {
        log.append({
          type: "user.message",
          session_thread_id: "sthr_X",
          content: [{ type: "text", text: `subX ${i}` }],
        } as any);
      }

      // Mark the FIRST primary message as already-processed (mid-turn).
      sql.exec(`UPDATE events SET processed_at = ? WHERE seq = 1`, Date.now());

      // Interrupt primary — flush all pending primary user.* events.
      const cancelTs = Date.now();
      sql.exec(
        `UPDATE events SET cancelled_at = ?
           WHERE session_thread_id = 'sthr_primary'
             AND processed_at IS NULL AND cancelled_at IS NULL
             AND (type = 'user.message' OR type = 'user.tool_confirmation' OR type = 'user.custom_tool_result')`,
        cancelTs,
      );

      // Primary: seq=1 processed (untouched), seq=2-3 cancelled.
      const primaryRows: any[] = [];
      for (const row of sql.exec(
        `SELECT seq, processed_at, cancelled_at FROM events
           WHERE session_thread_id = 'sthr_primary' ORDER BY seq`,
      )) {
        primaryRows.push(row);
      }
      expect(primaryRows[0].processed_at).not.toBeNull();
      expect(primaryRows[0].cancelled_at).toBeNull();
      expect(primaryRows[1].cancelled_at).toBe(cancelTs);
      expect(primaryRows[2].cancelled_at).toBe(cancelTs);

      // Subagent X: untouched (still pending).
      const subRows: any[] = [];
      for (const row of sql.exec(
        `SELECT processed_at, cancelled_at FROM events
           WHERE session_thread_id = 'sthr_X' ORDER BY seq`,
      )) {
        subRows.push(row);
      }
      expect(subRows[0].processed_at).toBeNull();
      expect(subRows[0].cancelled_at).toBeNull();
      expect(subRows[1].processed_at).toBeNull();
      expect(subRows[1].cancelled_at).toBeNull();
    });
  });

  it("getEvents projects cancelled_at_ms onto returned event objects", async () => {
    const stub = freshDoStub("pending_project");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      log.append({ type: "user.message", content: [{ type: "text", text: "first" }] } as any);
      log.append({ type: "user.message", content: [{ type: "text", text: "queued" }] } as any);
      log.append({ type: "user.message", content: [{ type: "text", text: "queued2" }] } as any);
      log.append({ type: "agent.message", id: "m_1", content: [{ type: "text", text: "ok" }] } as any);

      // Mark seq=1 processed, seq=2 + seq=3 cancelled.
      const ts = Date.now();
      sql.exec(`UPDATE events SET processed_at = ? WHERE seq = 1`, ts);
      sql.exec(`UPDATE events SET cancelled_at = ? WHERE seq IN (2, 3)`, ts);

      const events = log.getEvents();
      expect(events).toHaveLength(4);
      expect((events[0] as any).cancelled_at_ms).toBeUndefined();
      expect((events[1] as any).cancelled_at_ms).toBe(ts);
      expect((events[2] as any).cancelled_at_ms).toBe(ts);
      expect((events[3] as any).cancelled_at_ms).toBeUndefined();

      // eventsToMessages should now skip the two cancelled.
      const msgs = eventsToMessages(events);
      // First user.message + agent.message → 2 messages.
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect((msgs[0].content as any[])[0].text).toBe("first");
      expect(msgs[1].role).toBe("assistant");
    });
  });
});
