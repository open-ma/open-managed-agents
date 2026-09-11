import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { deletedSessionSchema, eventCreateBodySchema, listQuerySchema, messageItemSchema, pageSchema, sessionCreateBodySchema, sessionErrorEventSchema, sessionEventSchema, sessionListQuerySchema, sessionResponseSchema, sessionUpdateBodySchema, turnResponseSchema } from "./contracts";
import { toCreateSessionCommand, toMessageItemResponse, toSessionEvent, toSessionInput, toSessionResponse, toTurnResponse } from "./mappers";
import type { ApplicationError, ListQuery, Result, SessionEvent, SessionsApplicationPort } from "./ports";

export type SessionPortSource = SessionsApplicationPort | ((context: Context) => SessionsApplicationPort);
const errorBody = (message: string, code: string, type = "invalid_request_error", param: string | null = null) => ({ error: { message, code, type, param } });
const unsupported = (): ApplicationError => ({ type: "unsupported", message: "This capability is not connected to an application implementation" });

function applicationError(c: Context, error: ApplicationError): Response {
  const statuses = { invalidRequest: 400, notFound: 404, conflict: 409, unsupported: 501 } as const;
  const codes = { invalidRequest: "invalid_request", notFound: "resource_not_found", conflict: "conflict", unsupported: "unsupported_feature" };
  return c.json(errorBody(error.message, codes[error.type], error.type === "unsupported" ? "server_error" : "invalid_request_error", error.param ?? null), statuses[error.type]);
}

function validatedResponse<T>(c: Context, result: Result<T>, mapper: (value: T) => unknown, schema: z.ZodType): Response {
  if (result.type !== "success") return applicationError(c, result);
  try {
    const body = schema.safeParse(mapper(result.value));
    if (body.success) return c.json(body.data as object, 200);
  } catch { /* Mapping invalid application values must not escape as malformed JSON. */ }
  return c.json(errorBody("Application returned an invalid response", "invalid_application_response", "server_error"), 500);
}

function parse<T extends z.ZodType>(c: Context, schema: T, value: unknown): z.infer<T> | Response {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  return c.json(errorBody(`Invalid or unsupported field: ${issue?.message ?? "invalid value"}`, "invalid_request", "invalid_request_error", issue?.path.join(".") || null), 400);
}

async function jsonBody(c: Context): Promise<unknown | Response> {
  try { return await c.req.json(); }
  catch { return c.json(errorBody("Request body must be valid JSON", "invalid_request"), 400); }
}

function query(c: Context, includeAgent = false): ListQuery & { agentId?: string } | Response {
  // Keep unknown and duplicate keys visible to validation, rather than dropping them.
  const params = new URL(c.req.url).searchParams;
  const raw: Record<string, unknown> = {};
  for (const key of params.keys()) raw[key] = params.getAll(key).length > 1 ? params.getAll(key) : params.get(key);
  const parsed = parse(c, includeAgent ? sessionListQuerySchema : listQuerySchema, raw);
  if (parsed instanceof Response) return parsed;
  const { agent_id, ...rest } = parsed as ListQuery & { agent_id?: string };
  return { ...rest, ...(agent_id === undefined ? {} : { agentId: agent_id }) };
}

function eventStream(c: Context, events: AsyncIterable<SessionEvent>, controller: AbortController, cleanup: () => void, initialSessionId?: string): Response {
  let sessionId = initialSessionId;
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    try {
      for await (const event of events) {
        if (controller.signal.aborted) break;
        const wire = sessionEventSchema.parse(toSessionEvent(event));
        sessionId = "session" in wire ? wire.session.id : wire.session_id;
        await stream.writeSSE({ id: wire.event_id, event: wire.type, data: JSON.stringify(wire) });
      }
    } catch {
      if (!controller.signal.aborted) {
        const error = errorBody("Application event stream failed", "invalid_application_response", "server_error");
        // Before session creation yields an ID this is a transport error. Never
        // invent a durable session ID to make an event appear complete.
        const payload = sessionId === undefined ? error : sessionErrorEventSchema.parse({ ...error, type: "error", event_id: crypto.randomUUID(), session_id: sessionId });
        await stream.writeSSE({ event: "error", data: JSON.stringify(payload) });
      }
    } finally { cleanup(); }
  });
}

async function openEventStream(c: Context, open: (signal: AbortSignal) => Promise<Result<AsyncIterable<SessionEvent>>>, sessionId?: string): Promise<Response> {
  const controller = new AbortController();
  const requestSignal = c.req.raw.signal;
  const abort = () => controller.abort();
  if (requestSignal.aborted) abort();
  else requestSignal.addEventListener("abort", abort, { once: true });
  const cleanup = () => {
    requestSignal.removeEventListener("abort", abort);
    controller.abort();
  };
  try {
    const result = await open(controller.signal);
    if (result.type !== "success") {
      cleanup();
      return applicationError(c, result);
    }
    return eventStream(c, result.value, controller, cleanup, sessionId);
  } catch (error) { cleanup(); throw error; }
}

export function buildOpenAISessionRoutes(source: SessionPortSource): Hono {
  const app = new Hono();
  const port = (c: Context) => typeof source === "function" ? source(c) : source;
  app.onError((_error, c) => c.json(errorBody("An internal error occurred", "internal_error", "server_error"), 500));
  app.use("*", async (c, next) => {
    if (!c.req.header("OpenAI-Beta")?.split(",").some((token) => token.trim() === "agents=v1")) return c.json(errorBody("OpenAI-Beta: agents=v1 is required", "invalid_request", "invalid_request_error", "OpenAI-Beta"), 400);
    await next();
  });

  app.post("/", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const parsed = parse(c, sessionCreateBodySchema, body);
    if (parsed instanceof Response) return parsed;
    if (parsed.environment.type === "openai_hosted") return applicationError(c, { type: "unsupported", message: "Hosted session environment responses are not implemented by this adapter", param: "environment.type" });
    const command = toCreateSessionCommand(parsed);
    const application = port(c);
    if (parsed.stream) {
      if (!application.createSessionStream) return applicationError(c, unsupported());
      return openEventStream(c, (signal) => application.createSessionStream!(command, signal));
    }
    return validatedResponse(c, await application.createSession(command), toSessionResponse, sessionResponseSchema);
  });

  app.get("/", async (c) => {
    const parsed = query(c, true);
    if (parsed instanceof Response) return parsed;
    return validatedResponse(c, await port(c).listSessions(parsed), (page) => ({ data: page.data.map(toSessionResponse), has_more: page.hasMore }), pageSchema(sessionResponseSchema));
  });
  app.get("/:sessionId", async (c) => validatedResponse(c, await port(c).retrieveSession({ sessionId: c.req.param("sessionId") }), toSessionResponse, sessionResponseSchema));
  app.post("/:sessionId", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const parsed = parse(c, sessionUpdateBodySchema, body);
    if (parsed instanceof Response) return parsed;
    return validatedResponse(c, await port(c).updateSession({ sessionId: c.req.param("sessionId"), ...parsed }), toSessionResponse, sessionResponseSchema);
  });
  app.delete("/:sessionId", async (c) => validatedResponse(c, await port(c).deleteSession({ sessionId: c.req.param("sessionId") }), (value) => ({ id: value.sessionId, object: "agent.session.deleted", deleted: true }), deletedSessionSchema));

  app.post("/:sessionId/events", async (c) => {
    const body = await jsonBody(c);
    if (body instanceof Response) return body;
    const parsed = parse(c, eventCreateBodySchema, body);
    if (parsed instanceof Response) return parsed;
    const application = port(c);
    if (!application.sendEvents) return applicationError(c, unsupported());
    const idempotencyKey = c.req.header("Idempotency-Key");
    const result = await application.sendEvents({ sessionId: c.req.param("sessionId"), events: parsed.events.map(toSessionInput), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    return result.type === "success" ? c.body(null, 204) : applicationError(c, result);
  });
  app.get("/:sessionId/events", async (c) => {
    const application = port(c);
    if (!application.streamEvents) return applicationError(c, unsupported());
    return openEventStream(c, (signal) => application.streamEvents!({ sessionId: c.req.param("sessionId") }, signal), c.req.param("sessionId"));
  });
  app.get("/:sessionId/items", async (c) => {
    const parsed = query(c);
    if (parsed instanceof Response) return parsed;
    const application = port(c);
    if (!application.listItems) return applicationError(c, unsupported());
    return validatedResponse(c, await application.listItems({ ...parsed, sessionId: c.req.param("sessionId") }), (page) => ({ data: page.data.map(toMessageItemResponse), has_more: page.hasMore }), pageSchema(messageItemSchema));
  });
  app.get("/:sessionId/turns", async (c) => {
    const parsed = query(c);
    if (parsed instanceof Response) return parsed;
    const application = port(c);
    if (!application.listTurns) return applicationError(c, unsupported());
    return validatedResponse(c, await application.listTurns({ ...parsed, sessionId: c.req.param("sessionId") }), (page) => ({ data: page.data.map(toTurnResponse), has_more: page.hasMore }), pageSchema(turnResponseSchema));
  });
  app.get("/:sessionId/turns/:turnId", async (c) => {
    const application = port(c);
    if (!application.retrieveTurn) return applicationError(c, unsupported());
    return validatedResponse(c, await application.retrieveTurn({ sessionId: c.req.param("sessionId"), turnId: c.req.param("turnId") }), toTurnResponse, turnResponseSchema);
  });
  return app;
}
