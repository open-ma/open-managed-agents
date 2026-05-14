// @ts-nocheck
//
// Integration tests for the AMA-shaped event-log pending lifecycle.
// Reaches into a live SessionDO via runInDurableObject so the schema
// migration (ALTER TABLE ADD COLUMN + backfill) runs against real
// workerd SQLite, not a test-local mock.
//
// Coverage (post-dual-table refactor):
//   1. ensureSchema migrates v1 → v2 (no processed_at column → has all
//      three new columns, with legacy rows back-filled to "processed").
//   2. CfDoEventLog.append always writes to events with processed_at
//      stamped — adapter is now a primitive, queue routing lives in
//      SessionDO POST /event.
//   3. CfDoPendingQueue.enqueue + peek + delete + cancelAllForThread
//      drives the AMA-spec queue. Drain is peek-then-append-then-delete
//      with event-id dedup (tested separately at the SessionDO level).
//   4. eventsToMessages skips cancelled rows when re-read via getEvents.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  CfDoEventLog,
  CfDoPendingQueue,
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

  it("append stamps every event with processed_at — queue routing lives in SessionDO", async () => {
    const stub = freshDoStub("pending_append");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      // Adapter is a primitive: every append() writes to events with
      // processed_at = now. The dual-table refactor moved the
      // user.message → pending_events routing into SessionDO POST
      // /event; tests that exercise the queue path do so via
      // CfDoPendingQueue.enqueue (next test).
      log.append({ type: "user.message", content: [{ type: "text", text: "hi" }] } as any);
      log.append({ type: "agent.message", content: [{ type: "text", text: "yo" }] } as any);

      const rows: any[] = [];
      for (const row of sql.exec(
        `SELECT type, processed_at FROM events ORDER BY seq`,
      )) {
        rows.push(row);
      }
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe("user.message");
      expect(rows[0].processed_at).not.toBeNull();
      expect(rows[1].type).toBe("agent.message");
      expect(rows[1].processed_at).not.toBeNull();
    });
  });

  it("CfDoPendingQueue.enqueue + peek returns FIFO scoped to thread", async () => {
    const stub = freshDoStub("pending_lookup");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const queue = new CfDoPendingQueue(sql);

      // Five user.message on primary, two on a sub-agent thread.
      for (let i = 1; i <= 5; i++) {
        const e: any = {
          type: "user.message",
          content: [{ type: "text", text: `primary ${i}` }],
        };
        stamp(e);
        queue.enqueue(e);
      }
      for (let i = 1; i <= 2; i++) {
        const e: any = {
          type: "user.message",
          session_thread_id: "sthr_subagentA",
          content: [{ type: "text", text: `sub ${i}` }],
        };
        stamp(e);
        queue.enqueue(e);
      }

      const p0 = queue.peek("sthr_primary");
      expect(p0).not.toBeNull();
      expect(JSON.parse(p0!.data).content[0].text).toBe("primary 1");

      const sub0 = queue.peek("sthr_subagentA");
      expect(sub0).not.toBeNull();
      expect(JSON.parse(sub0!.data).content[0].text).toBe("sub 1");

      // Delete primary 1 → next peek returns primary 2.
      queue.delete(p0!.pending_seq);
      const p1 = queue.peek("sthr_primary");
      expect(JSON.parse(p1!.data).content[0].text).toBe("primary 2");

      // Subagent thread untouched.
      const sub1 = queue.peek("sthr_subagentA");
      expect(JSON.parse(sub1!.data).content[0].text).toBe("sub 1");

      // List + countActive sanity check
      expect(queue.list("sthr_primary")).toHaveLength(4);
      expect(queue.list("sthr_subagentA")).toHaveLength(2);
      expect(queue.countActive()).toBe(6);
      expect(queue.threadsWithPending().sort()).toEqual([
        "sthr_primary",
        "sthr_subagentA",
      ]);
    });
  });

  it("cancelAllForThread flushes only the target thread", async () => {
    const stub = freshDoStub("pending_interrupt");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const queue = new CfDoPendingQueue(sql);

      // 3 pending on primary, 2 on subagent.
      for (let i = 1; i <= 3; i++) {
        const e: any = {
          type: "user.message",
          content: [{ type: "text", text: `primary ${i}` }],
        };
        stamp(e);
        queue.enqueue(e);
      }
      for (let i = 1; i <= 2; i++) {
        const e: any = {
          type: "user.message",
          session_thread_id: "sthr_X",
          content: [{ type: "text", text: `subX ${i}` }],
        };
        stamp(e);
        queue.enqueue(e);
      }

      // Interrupt primary — flush all pending primary user.* events.
      const cancelTs = Date.now();
      const cancelled = queue.cancelAllForThread("sthr_primary", cancelTs);
      expect(cancelled).toHaveLength(3);

      // Active list now empty for primary; subagent untouched.
      expect(queue.list("sthr_primary")).toHaveLength(0);
      expect(queue.list("sthr_X")).toHaveLength(2);

      // include_cancelled returns the soft-deleted rows.
      const all = queue.list("sthr_primary", true);
      expect(all).toHaveLength(3);
      expect(all[0].cancelled_at).toBe(cancelTs);
      expect(all[2].cancelled_at).toBe(cancelTs);

      // Subagent X: untouched (still pending).
      const subRows = queue.list("sthr_X");
      expect(subRows).toHaveLength(2);
      expect(subRows[0].cancelled_at).toBeNull();
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

      // Mark seq=2 + seq=3 cancelled (simulating user.interrupt where
      // these rows had been promoted into events but should be skipped
      // in LLM context).
      const ts = Date.now();
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
