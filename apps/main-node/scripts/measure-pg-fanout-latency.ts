import { createPostgresSqlClient } from "@open-managed-agents/sql-client";
import { ensureSchema, SqlEventLog } from "@open-managed-agents/event-log/sql";
import { PgEventStreamHub } from "../src/lib/pg-event-stream-hub.js";

const dsn = process.env.PG_TEST_URL;
if (!dsn) {
  console.error("PG_TEST_URL required");
  process.exit(1);
}
const sql = await createPostgresSqlClient(dsn);
await ensureSchema(sql, "postgres");
const fetcher = (s: string, after: number) =>
  new SqlEventLog(sql, s, () => {}).getEventsAsync(after);
const hubA = await PgEventStreamHub.create({ dsn, fetchEventsAfter: fetcher });
const hubB = await PgEventStreamHub.create({ dsn, fetchEventsAfter: fetcher });
const sid = "sess_lat_" + Date.now();
const lats: number[] = [];
for (let i = 0; i < 7; i++) {
  let resolveT: (v: number) => void = () => {};
  const got = new Promise<number>((r) => {
    resolveT = r;
  });
  const writer = {
    closed: false,
    write(_ev: unknown) {
      resolveT(Date.now());
    },
    close() {
      this.closed = true;
    },
  };
  const off = hubB.attach(sid, writer);
  const log = new SqlEventLog(sql, sid, () => {});
  await log.appendAsync({
    type: "agent.message",
    content: [{ type: "text", text: "ping " + i }],
  } as never);
  const stored = await log.getEventsAsync();
  const last = stored[stored.length - 1]!;
  const t0 = Date.now();
  hubA.publish(sid, last);
  const t1 = await got;
  lats.push(t1 - t0);
  off();
  await new Promise((r) => setTimeout(r, 50));
}
console.log("A→B latencies (ms):", lats.join(", "));
const sorted = lats.slice().sort((a, b) => a - b);
console.log("min/median/max:", sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]);
await hubA.stop();
await hubB.stop();
await sql.prepare("DELETE FROM session_events WHERE session_id = ?").bind(sid).run();
process.exit(0);
