import { describe, expect, it } from "vitest";
import { SessionEventsApplicationService } from "../src/session-events/application";

describe("durable Session input idempotency", () => {
  function fixture() {
    const log = new Map<string, any>();
    const dispatched: unknown[] = [];
    let revision = 1, sequence = 0;
    const session: any = { id: "session", updatedAt: "2026-09-11T00:00:00.000Z", outcomeEvaluations: [] };
    const dependencies: any = {
      workspaceId: "workspace", clock: { now: () => new Date(1800000000000 + sequence++) },
      ids: { nextEventId: () => `random-${sequence++}`, nextOutcomeId: () => `outcome-${sequence++}` },
      execution: { find: async () => ({session, environment: {}, revision}) },
      sessions: { find: async () => session }, stream: { subscribe: () => (async function*(){})() },
      store: {
        async list(input: any) { return [...log.values()].filter(event => !input.idPrefix || event.id.startsWith(input.idPrefix)).slice(0, input.limit); },
        async append(input: any) {
          if (input.expectedRevision !== revision) return {type:"revision_conflict",actualRevision:revision};
          revision++;
          for (const event of input.events) log.set(event.id, structuredClone(event));
          return {type:"appended",events:input.events,session:input.nextSession};
        },
      },
      dispatch: { sessionEventsAccepted: async (input: any) => { dispatched.push(input); } },
    };
    return { log, dispatched, dependencies, service: () => new SessionEventsApplicationService(dependencies) };
  }
  it("replays the original accepted identities after reconstruction without dispatching again", async () => {
    const f = fixture();
    const command: any = { sessionId:"session", idempotencyKey:"key", events:[{type:"user.message",content:[{type:"text",text:"once"}]}] };
    const first = await f.service().sendSessionEvents(command);
    const again = await f.service().sendSessionEvents(command);
    expect(again).toEqual(first);
    expect(f.dispatched).toHaveLength(1);
    expect(f.log.size).toBe(1);
  });
  it("serializes concurrent retries and rejects reusing a key with a changed batch", async () => {
    const f = fixture();
    const command: any = { sessionId:"session", idempotencyKey:"key", events:[{type:"user.message",content:[{type:"text",text:"once"}]}] };
    const results = await Promise.all([f.service().sendSessionEvents(command), f.service().sendSessionEvents(command)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.dispatched).toHaveLength(1);
    expect(await f.service().sendSessionEvents({...command,events:[...command.events,{type:"user.interrupt"}]})).toMatchObject({type:"idempotency_conflict"});
    expect(f.dispatched).toHaveLength(1);
  });
});
