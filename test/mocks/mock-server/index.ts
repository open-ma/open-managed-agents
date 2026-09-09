/**
 * mock-services Worker — combines MCP server mock + OAuth provider mock for
 * e2e testing of paths the real OMA gateway can't reach in CI.
 *
 * Endpoints
 * ─────────
 *
 *   POST /v1/messages
 *     → deterministic Anthropic-compatible message or SSE stream. Used by
 *       deployment E2E so D1/DO/harness/API stay real while the LLM is mocked.
 *
 *   POST /oauth/authorize?client_id=...&redirect_uri=...&state=...
 *     → 302 to {redirect_uri}?code=mock_code_<random>&state=<state>
 *     The OAuth callback flow used by publication-first install.
 *
 *   POST /oauth/token
 *     Body: grant_type=authorization_code | refresh_token, ...standard fields
 *     → 200 {access_token, refresh_token, token_type:"Bearer", expires_in}
 *     Refresh-token grant rotates the refresh_token too (matches real Linear /
 *     Slack / GitHub behavior).
 *
 *   ALL /mcp/{scenario}/{tail...}
 *     scenario discriminator picks behavior, controllable per request:
 *     - `ok`         — always 200 with a tiny `tools/list` response
 *     - `401-once`   — first call per session returns 401 + WWW-Authenticate
 *                      with `error="invalid_token"`. Subsequent calls 200.
 *                      "Session" keyed by the bearer token: a new token gets
 *                      a fresh 401 budget.
 *     - `403-always` — every call returns 403 (tests the 403→refresh trigger
 *                      we added to mcp-proxy)
 *     - `expire/{ttl_seconds}` — bearer is valid for ttl_seconds from first
 *                      use, then 401 until a new bearer arrives. Lets you
 *                      script the refresh-token race.
 *
 *   GET /__/state — debug: dump the bearer→state map
 *   POST /__/reset — wipe state (test isolation)
 *
 * State per scenario is in a single MockStateDO. Each bearer token is a key;
 * the value tracks first-seen-at + call counts.
 */

export interface Env {
  MOCK_STATE: DurableObjectNamespace;
}

const ISSUED_CODES = new Set<string>(); // ephemeral; per-worker-instance memory

function bearerOf(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // ─── Anthropic-compatible LLM: /v1/messages ──────────────────────
    if (p === "/v1/messages" && req.method === "POST") {
      if (!req.headers.get("x-api-key")) {
        return json({ type: "error", error: { type: "authentication_error", message: "missing mock key" } }, 401);
      }
      const body = await req.json<Record<string, unknown>>().catch(() => ({}));
      const model = typeof body.model === "string" ? body.model : "openma-e2e-mock";
      console.log(JSON.stringify({
        event: "mock_llm_request",
        model,
        stream: body.stream === true,
        messages: Array.isArray(body.messages) ? body.messages.length : 0,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        bodyBytes: JSON.stringify(body).length,
      }));
      const messageId = `msg_mock_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const planned = buildModelMessage(body, model, messageId);
      if (planned instanceof Response) {
        console.warn(JSON.stringify({
          event: "mock_llm_rejected",
          model,
          status: planned.status,
        }));
        return planned;
      }
      console.log(JSON.stringify({
        event: "mock_llm_response",
        model,
        stopReason: planned.stop_reason,
        contentType: planned.content[0]?.type ?? "empty",
      }));
      if (body.stream === true) {
        return anthropicSse(planned);
      }
      return json(planned);
    }

    // ─── OAuth: /oauth/authorize ──────────────────────────────────────
    if (p === "/oauth/authorize" || p === "/oauth/authorize/") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (!redirectUri) return json({ error: "missing redirect_uri" }, 400);
      const code = randomToken("mock_code");
      ISSUED_CODES.add(code);
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    }

    // ─── OAuth: /oauth/token ──────────────────────────────────────────
    if (p === "/oauth/token") {
      const body = await req.formData().catch(() => null);
      const params = body
        ? Object.fromEntries(body.entries())
        : (await req.json().catch(() => ({}))) as Record<string, string>;
      const grant = String(params["grant_type"] ?? "");

      if (grant === "authorization_code") {
        const code = String(params["code"] ?? "");
        // accept the issued code or any "mock_code_*" so the test can plug a
        // fixed value without round-tripping through /authorize first
        if (!code.startsWith("mock_code")) {
          return json({ error: "invalid_grant", error_description: "unknown code" }, 400);
        }
        ISSUED_CODES.delete(code);
        return json({
          access_token: randomToken("mock_at"),
          refresh_token: randomToken("mock_rt"),
          token_type: "Bearer",
          expires_in: 3600,
          scope: String(params["scope"] ?? "read write"),
        });
      }

      if (grant === "refresh_token") {
        const rt = String(params["refresh_token"] ?? "");
        if (!rt.startsWith("mock_rt")) {
          return json({ error: "invalid_grant", error_description: "unknown refresh_token" }, 400);
        }
        return json({
          access_token: randomToken("mock_at"),
          refresh_token: randomToken("mock_rt"),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      return json({ error: "unsupported_grant_type", grant_type: grant }, 400);
    }

    // ─── MCP scenarios: /mcp/{scenario}/{tail} ────────────────────────
    if (p.startsWith("/mcp/")) {
      const parts = p.slice("/mcp/".length).split("/");
      const scenario = parts.shift() ?? "";
      const tail = parts.join("/");
      const dispatchUrl = new URL(`/dispatch/${tail}`, url.origin).toString();
      const stub = await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(scenario)).fetch(
        dispatchUrl,
        {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
        },
      );
      return stub;
    }

    // ─── State inspectors ─────────────────────────────────────────────
    if (p === "/__/state") {
      // Aggregate across known scenario names (we just look at the well-known ones)
      const scenarios = ["ok", "401-once", "403-always", "expire"];
      const out: Record<string, unknown> = {};
      for (const s of scenarios) {
        const r = await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(s))
          .fetch(new URL("/state", url.origin).toString());
        out[s] = await r.json();
      }
      return json(out);
    }
    if (p === "/__/reset") {
      const scenarios = ["ok", "401-once", "403-always", "expire"];
      for (const s of scenarios) {
        await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(s))
          .fetch(new URL("/reset", url.origin).toString(), { method: "POST" });
      }
      return json({ ok: true });
    }

    // ─── Root: a short README ────────────────────────────────────────
    if (p === "/" || p === "/health") {
      return json({
        service: "oma-mock-services",
        endpoints: {
          llm: ["POST /v1/messages"],
          oauth: ["GET /oauth/authorize", "POST /oauth/token"],
          mcp: [
            "ALL /mcp/ok/...",
            "ALL /mcp/401-once/...",
            "ALL /mcp/403-always/...",
            "ALL /mcp/expire/{ttl_seconds}/...",
          ],
          admin: ["GET /__/state", "POST /__/reset"],
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
};

// ─── Durable Object: per-scenario per-bearer state ───────────────────

export class MockStateDO {
  private state: DurableObjectState;
  // bearer → { firstSeenMs, callCount, scenarioMeta }
  private bearers = new Map<string, { firstSeenMs: number; callCount: number }>();
  // scenario name comes from DO id name (set by caller via idFromName)
  private scenario: string;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.scenario = state.id.name ?? "ok";
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/state") {
      return Response.json({
        scenario: this.scenario,
        bearers: Array.from(this.bearers.entries()).map(([t, s]) => ({
          token: `${t.slice(0, 12)}…`,
          firstSeenMs: s.firstSeenMs,
          callCount: s.callCount,
        })),
      });
    }
    if (url.pathname === "/reset" && req.method === "POST") {
      this.bearers.clear();
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/dispatch" && !url.pathname.startsWith("/dispatch/")) {
      return new Response("not found", { status: 404 });
    }

    const bearer = bearerOf(req) ?? "<no-bearer>";
    let entry = this.bearers.get(bearer);
    if (!entry) {
      entry = { firstSeenMs: Date.now(), callCount: 0 };
      this.bearers.set(bearer, entry);
    }
    entry.callCount += 1;

    switch (this.scenario) {
      case "ok":
        return mcpProtocolResponse(req, this.scenario);

      case "401-once":
        if (entry.callCount === 1) {
          return new Response(
            JSON.stringify({ error: "invalid_token" }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "www-authenticate": 'Bearer error="invalid_token"',
              },
            },
          );
        }
        return mcpProtocolResponse(req, this.scenario);

      case "403-always":
        return new Response(
          JSON.stringify({ error: "forbidden" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );

      case "expire": {
        // path embeds /mcp/expire/{ttl}/... — read ttl from the first
        // segment of /dispatch/{ttl}/...
        const tail = url.pathname.slice("/dispatch/".length);
        const ttlMatch = /^(\d+)/.exec(tail);
        const ttl = ttlMatch ? Number(ttlMatch[1]) : 5;
        const ageMs = Date.now() - entry.firstSeenMs;
        if (ageMs > ttl * 1000) {
          return new Response(
            JSON.stringify({ error: "invalid_token", error_description: "expired" }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "www-authenticate": 'Bearer error="invalid_token"',
              },
            },
          );
        }
        return mcpProtocolResponse(req, this.scenario);
      }

      default:
        return new Response("unknown scenario", { status: 404 });
    }
  }
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContent[];
  model: string;
  stop_reason: "end_turn" | "tool_use";
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

function buildModelMessage(
  body: Record<string, unknown>,
  model: string,
  messageId: string,
): AnthropicMessage | Response {
  const base = {
    id: messageId,
    type: "message" as const,
    role: "assistant" as const,
    model,
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 2 },
  };
  if (model !== "openma-e2e-inputs") {
    return {
      ...base,
      content: [{ type: "text", text: "E2E_OK" }],
      stop_reason: "end_turn",
    };
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let currentTurnStart = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Record<string, unknown> | null;
    if (
      message?.role === "user"
      && !/tool[_-]result/iu.test(JSON.stringify(message))
    ) {
      currentTurnStart = index;
    }
  }
  const turn = messages.slice(Math.max(currentTurnStart, 0));
  const repositorySha = /Expected repository SHA:\s*([0-9a-f]{7,64})/iu.exec(
    JSON.stringify(messages[currentTurnStart] ?? {}),
  )?.[1];
  // Model-card creation verifies provider reachability with a one-token
  // request before any Session/repository exists. Keep that probe cheap and
  // side-effect free; only a normal turn enters the certification tool plan.
  if (!repositorySha && Number(body.max_tokens) === 1) {
    return {
      ...base,
      content: [{ type: "text", text: "E2E_OK" }],
      stop_reason: "end_turn",
    };
  }
  if (!repositorySha) {
    return json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "input certification requires an expected repository SHA",
      },
    }, 422);
  }
  const toolResults = turn
    .flatMap((message) => {
      const content = (message as Record<string, unknown> | null)?.content;
      return Array.isArray(content) ? content : [];
    })
    .filter((block) => {
      const type = (block as Record<string, unknown> | null)?.type;
      return /tool[_-]result/iu.test(String(type ?? ""));
    });
  const plan = [
    {
      name: "bash",
      input: {
        command: [
          "set -eu",
          'test "$(cat /workspace/inputs/attached.txt)" = "FILE_INPUT_OK"',
          'skill_file="$(find /workspace/.openma/skills -name SKILL.md -type f | head -n 1)"',
          'test -n "$skill_file"',
          'grep -q "SKILL_INPUT_OK" "$skill_file"',
          'test "$(cat "$OMA_MEMORY_CERTIFICATION_MEMORY/notes/input.txt")" = "MEMORY_INPUT_OK"',
          'test -f /workspace/repository/README.md',
          `test "$(git -C /workspace/repository rev-parse HEAD)" = "${repositorySha}"`,
          'printf "OUTPUT_OK" > "$OMA_OUTPUTS_DIR/certification.txt"',
          "printf FILES_REPO_SKILL_MEMORY_OUTPUT_OK",
        ].join("; "),
      },
      expectedResult: "FILES_REPO_SKILL_MEMORY_OUTPUT_OK",
    },
    {
      name: "mcp__certification__echo",
      input: { value: "MCP_INPUT_OK" },
      expectedResult: "MCP_PROXY_OK",
    },
  ] as const;
  const invalidIndex = toolResults.findIndex((result, index) =>
    !JSON.stringify(result).includes(plan[index]?.expectedResult ?? ""));
  if (invalidIndex >= 0) {
    return json({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `tool result did not contain ${plan[invalidIndex]?.expectedResult}`,
      },
    }, 422);
  }
  const next = plan[toolResults.length];
  if (next) {
    return {
      ...base,
      content: [{
        type: "tool_use",
        id: `toolu_mock_${toolResults.length}`,
        name: next.name,
        input: next.input,
      }],
      stop_reason: "tool_use",
    };
  }
  return {
    ...base,
    content: [{ type: "text", text: "ALL_INPUTS_OK" }],
    stop_reason: "end_turn",
  };
}

function anthropicSse(message: AnthropicMessage): Response {
  const block = message.content[0]!;
  const events: Array<readonly [string, unknown]> = [
    ["message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    }],
    ["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: block.type === "tool_use"
        ? { ...block, input: {} }
        : { type: "text", text: "" },
    }],
    ["content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(
    events.map(([event, data]) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    ).join(""),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    },
  );
}

async function mcpProtocolResponse(req: Request, scenario: string): Promise<Response> {
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  const message = await req.json<Record<string, unknown>>().catch(() => ({}));
  const id = message.id ?? null;
  const method = String(message.method ?? "");
  const sessionId = `openma-mock-${scenario}-session`;
  if (method === "server/discover") {
    return mcpJson(id, undefined, { code: -32601, message: "Method not found" });
  }
  if (method === "initialize") {
    const params = message.params as Record<string, unknown> | undefined;
    return mcpJson(id, {
      protocolVersion: String(params?.protocolVersion ?? "2025-06-18"),
      capabilities: { tools: {} },
      serverInfo: { name: "openma-mock-services", version: "1.0.0" },
    }, undefined, { "mcp-session-id": sessionId });
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (method && req.headers.get("mcp-session-id") !== sessionId) {
    return new Response("unknown MCP session", { status: 404 });
  }
  if (method === "tools/call") {
    const params = message.params as Record<string, unknown> | undefined;
    const args = params?.arguments as Record<string, unknown> | undefined;
    if (params?.name !== "echo" || args?.value !== "MCP_INPUT_OK") {
      return mcpJson(id, undefined, {
        code: -32602,
        message: "echo requires the MCP_INPUT_OK certification marker",
      });
    }
    return mcpJson(id, {
      content: [{ type: "text", text: "MCP_PROXY_OK" }],
      structuredContent: { marker: "MCP_PROXY_OK" },
    });
  }
  if (method === "tools/list" || method === "") {
    return mcpJson(id, {
      tools: [{
        name: "echo",
        description: "Return the certification marker",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }],
    });
  }
  return mcpJson(id, undefined, { code: -32601, message: "Method not found" });
}

function mcpJson(
  id: unknown,
  result?: unknown,
  error?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error === undefined ? { result } : { error }),
  }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}
