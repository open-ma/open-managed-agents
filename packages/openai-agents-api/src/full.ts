import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { validateOpenAIAgentsRequestSemantics, validateOpenAIAgentsSchema, type OpenAIAgentsValidation } from "./full-contracts";
import { openAIAgentsOperations, type OpenAIAgentsOperation, type OpenAIAgentsOperationDefinition } from "./full-operations";

export type OpenAIAgentsQueryValue = string | string[] | number | boolean | null;
export interface OpenAIAgentsOperationRequest {
  operation: OpenAIAgentsOperation;
  params: Record<string, string>;
  query: Record<string, OpenAIAgentsQueryValue>;
  body: Record<string, unknown>;
  headers: Headers;
  /** A transport disconnect only closes a subscription; explicit cancel is a durable input. */
  signal: AbortSignal;
}
export interface OpenAIAgentsOperationResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  stream?: AsyncIterable<Record<string, unknown>>;
  binary?: BodyInit;
}
export interface OpenAIAgentsProtocolPort { execute(request: OpenAIAgentsOperationRequest): Promise<OpenAIAgentsOperationResponse> }
export type OpenAIAgentsProtocolPortSource = OpenAIAgentsProtocolPort | ((context: Context) => OpenAIAgentsProtocolPort);
export class OpenAIAgentsProtocolError extends Error {
  constructor(readonly status: number, message: string, readonly param?: string, readonly code?: string) { super(message); this.name = "OpenAIAgentsProtocolError"; }
}
const errorBody = (error: OpenAIAgentsProtocolError) => ({ error: {
  message: error.message,
  type: error.status >= 500 ? "server_error" : error.status === 429 ? "rate_limit_error" : error.status === 401 ? "authentication_error" : "invalid_request_error",
  param: error.param ?? null,
  code: error.code ?? (error.status === 404 ? "resource_not_found" : error.status === 409 ? "conflict" : error.status >= 500 ? "internal_error" : "invalid_request"),
} });
function invalid(result: OpenAIAgentsValidation): void {
  if (!result.success) throw new OpenAIAgentsProtocolError(400, result.issue.message, result.issue.path || undefined, "invalid_request");
}
function invalidResponse(): never { throw new OpenAIAgentsProtocolError(500, "Application returned an invalid response", undefined, "invalid_application_response"); }

function validateResponse(definition: OpenAIAgentsOperationDefinition, value: unknown): void {
  if (!definition.responseSchema) return;
  if (definition.mode === "page" || definition.mode === "tokenPage") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalidResponse();
    const page = value as Record<string, unknown>;
    if (!Array.isArray(page.data) || typeof page.has_more !== "boolean") return invalidResponse();
    if (Object.keys(page).some(key => !["data", "has_more", ...(definition.mode === "tokenPage" ? ["next"] : [])].includes(key))) return invalidResponse();
    if (definition.mode === "tokenPage" && !(page.next === null || (typeof page.next === "string" && page.next.length))) return invalidResponse();
    if (page.has_more && (!page.data.length || (definition.mode === "tokenPage" ? !page.next : !page.data.at(-1)?.id))) return invalidResponse();
    for (const item of page.data) if (!validateOpenAIAgentsSchema(item, definition.responseSchema).success) return invalidResponse();
    return;
  }
  if (!validateOpenAIAgentsSchema(value, definition.responseSchema).success) return invalidResponse();
}

export function buildOpenAIAgentsProtocolApi(source: OpenAIAgentsProtocolPortSource): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const safe = error instanceof OpenAIAgentsProtocolError ? error : new OpenAIAgentsProtocolError(500, "An internal error occurred");
    return new Response(JSON.stringify(errorBody(safe)), { status: safe.status, headers: { "content-type": "application/json" } });
  });
  app.notFound(c => c.json(errorBody(new OpenAIAgentsProtocolError(404, "Unknown API endpoint")), 404));
  app.use("*", async (c, next) => {
    if (!c.req.header("OpenAI-Beta")?.split(",").some(token => token.trim() === "agents=v1")) throw new OpenAIAgentsProtocolError(400, "OpenAI-Beta: agents=v1 is required", "OpenAI-Beta");
    await next();
  });
  for (const operation of openAIAgentsOperations) {
    const definition: OpenAIAgentsOperationDefinition = operation;
    app.on(definition.method, definition.path, async c => {
      let body: Record<string, unknown> = {};
      if (definition.bodySchema) {
        const raw = await c.req.text();
        try { body = raw ? JSON.parse(raw) : {}; }
        catch { throw new OpenAIAgentsProtocolError(400, "Request body must be valid JSON"); }
        invalid(validateOpenAIAgentsSchema(body, definition.bodySchema, { omit: definition.omit }));
      }
      const search = new URL(c.req.url).searchParams;
      const query: Record<string, OpenAIAgentsQueryValue> = Object.create(null);
      for (const key of new Set(search.keys())) {
        const values = search.getAll(key);
        if (key === "status[]") {
          if (search.has("status")) throw new OpenAIAgentsProtocolError(400, "status and status[] cannot be combined", "status");
          query.status = values;
        } else query[key] = values.length === 1 ? values[0]! : values;
      }
      if (typeof query.limit === "string" && query.limit.trim() !== "") query.limit = Number(query.limit);
      if (definition.querySchema) invalid(validateOpenAIAgentsSchema(query, definition.querySchema, { omit: definition.omit }));
      else if (Object.keys(query).length) throw new OpenAIAgentsProtocolError(400, "Unknown query parameter", Object.keys(query)[0]);
      invalid(validateOpenAIAgentsRequestSemantics(operation.operation, body, query));
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (c.req.raw.signal.aborted) controller.abort();
      else c.req.raw.signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => { c.req.raw.signal.removeEventListener("abort", abort); controller.abort(); };
      let response: OpenAIAgentsOperationResponse;
      try {
        const port = typeof source === "function" ? source(c) : source;
        response = await port.execute({ operation: operation.operation, body, query, params: c.req.param(), headers: c.req.raw.headers, signal: controller.signal });
      } catch (error) { cleanup(); throw error; }
      const streaming = definition.mode === "stream" || (operation.operation === "sessions.create" && body.stream === true);
      if (streaming) {
        if (!response.stream) { cleanup(); return invalidResponse(); }
        return streamSSE(c, async stream => {
          stream.onAbort(abort);
          let sessionId = c.req.param("session_id");
          try {
            for await (const event of response.stream!) {
              if (controller.signal.aborted) break;
              if (!validateOpenAIAgentsSchema(event, "agents.AgentSessionEvent").success) return invalidResponse();
              sessionId = typeof event.session_id === "string" ? event.session_id : (event.session as { id?: string } | undefined)?.id ?? sessionId;
              await stream.writeSSE({ id: String(event.event_id), event: String(event.type), data: JSON.stringify(event) });
            }
          } catch {
            if (!controller.signal.aborted) {
              const error = errorBody(new OpenAIAgentsProtocolError(500, "Application event stream failed", undefined, "invalid_application_response"));
              const payload = sessionId ? { type: "error", event_id: crypto.randomUUID(), session_id: sessionId, ...error } : error;
              await stream.writeSSE({ event: "error", data: JSON.stringify(payload) });
            }
          } finally { cleanup(); }
        });
      }
      cleanup();
      if (definition.mode === "void") return new Response(null, { status: 204, headers: response.headers });
      if (definition.mode === "binary") {
        if (response.binary === undefined) return invalidResponse();
        return new Response(response.binary, { status: response.status ?? 200, headers: { "content-type": "application/octet-stream", ...response.headers } });
      }
      validateResponse(definition, response.body);
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { "content-type": "application/json", ...response.headers } });
    });
  }
  return app;
}
