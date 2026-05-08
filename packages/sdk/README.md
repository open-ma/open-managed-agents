# @openma/sdk

> ## ⚠️ Deprecated — use `@anthropic-ai/sdk` instead
>
> This package is no longer the recommended way to call the openma platform.
> The openma API is **wire-compatible with Anthropic's Managed Agents API**, so
> you can use the official Anthropic SDK directly:
>
> ```bash
> npm i @anthropic-ai/sdk
> ```
>
> ```ts
> import Anthropic from "@anthropic-ai/sdk";
>
> const client = new Anthropic({
>   baseURL: "https://openma.dev",
>   apiKey: process.env.OMA_API_KEY!,
> });
>
> const env = await client.beta.environments.create({
>   name: "my-env",
>   config: {
>     type: "cloud",
>     networking: { type: "unrestricted" },
>     packages: { type: "packages" },
>   },
> });
> ```
>
> The same SDK works against Anthropic's hosted API and any other compatible
> server — moving between providers is a `baseURL` change. OMA-specific
> endpoints (tenants, OAuth, evals, cost reports, …) live under `/v1/oma/*` and
> can be invoked via `client._client.post('/v1/oma/...', ...)`.
>
> No new versions of `@openma/sdk` will be published. The source remains in the
> repo for reference. Existing users continue to work; please migrate at your
> convenience.

---

Official TypeScript SDK for the [openma](https://openma.dev) managed agents platform — typed REST + SSE streaming, runs anywhere `fetch` exists (Node ≥ 20, Bun, Deno, browsers, Cloudflare Workers).

## Install

```bash
npm i @openma/sdk
# or
pnpm add @openma/sdk
# or
bun add @openma/sdk
```

## Quick start

```ts
import { OpenMA } from "@openma/sdk";

const oma = new OpenMA({ apiKey: process.env.OMA_API_KEY! });

// Streaming chat — async iterator over typed events.
for await (const ev of oma.sessions.chat(sessionId, "Hello")) {
  if (ev.type === "agent.message_chunk") process.stdout.write(ev.delta);
}
```

## Why streaming is first-class

Three kinds of stream — text, thinking, tool input — flow over the same SSE channel. Each carries a correlation id (`message_id`, `thinking_id`, `tool_use_id`) that matches the eventually-committed canonical event. The discriminated-union narrowing handles the rest:

```ts
for await (const ev of oma.sessions.chat(sessionId, "Use bash to print uptime")) {
  switch (ev.type) {
    case "agent.message_chunk":
      // Live text delta — incremental render.
      process.stdout.write(ev.delta);
      break;
    case "agent.message":
      // Canonical message — same message_id as the chunks above. Drop
      // your in-flight buffer; this content is the source of truth.
      break;
    case "agent.thinking_chunk":
      // Live extended-thinking delta.
      process.stderr.write(`💭 ${ev.delta}`);
      break;
    case "agent.tool_use":
      // Tool call committed — `id` matches any prior tool_use_input_chunk events.
      console.log(`→ ${ev.name}`, ev.input);
      break;
    case "agent.tool_result":
      console.log(`← ${ev.content}`);
      break;
    case "session.warning":
      // The recovery scan reconciled an interrupted stream after a
      // runtime restart — surface to the user as "stream dropped".
      console.warn(`⚠ ${ev.source}: ${ev.message}`);
      break;
    case "session.status_idle":
      return; // turn done; the server closes the stream too
  }
}
```

## High-level chatComplete

When you don't need token-by-token rendering, `chatComplete` accumulates the stream into a structured summary:

```ts
const reply = await oma.sessions.chatComplete(sessionId, "Hello", {
  onText: (delta) => process.stdout.write(delta), // optional incremental hook
});

console.log(reply.text);           // assembled assistant text
console.log(reply.thinking);       // string[] — one per reasoning block
console.log(reply.toolCalls);      // {id, name, input}[] for every tool call
console.log(reply.toolResults);    // results paired by tool_use_id
```

## Long-lived tail

For monitoring / dashboards / agent-to-agent observability:

```ts
// Replays history on connect, then streams every future event.
// Never closes; pass an AbortSignal or break out of the loop to stop.
for await (const ev of oma.sessions.tail(sessionId, { signal: ac.signal })) {
  console.log(ev.type, ev);
}
```

## Resources covered

| Resource | Methods |
|---|---|
| `oma.agents` | `list`, `get`, `create`, `update`, `delete` |
| `oma.sessions` | `list`, `get`, `create`, `chat`, `chatComplete`, `tail`, `events`, `message`, `interrupt`, `archive`, `delete` |
| `oma.environments` | `list`, `get`, `create`, `delete` |

More resources land per release — file an issue if something you need is missing.

## Errors

Every non-2xx throws an `OpenMAError`:

```ts
import { OpenMAError } from "@openma/sdk";

try {
  await oma.sessions.get("sess-bogus");
} catch (err) {
  if (err instanceof OpenMAError) {
    console.error(err.status, err.body);
    if (err.status === 404) { /* handle missing */ }
  }
}
```

## Auth

```ts
// API key — server-to-server, CLI scripts. Sent as `x-api-key`.
new OpenMA({ apiKey: "oma_..." });

// Cookie auth — for embedding in the Console UI. Sent as `Authorization: Bearer ...`.
new OpenMA({ bearer: cookieToken });

// Self-host
new OpenMA({ apiKey: "oma_...", baseUrl: "https://your.openma.example" });

// Multi-tenant (cookie-auth users in workspaces with multiple memberships)
new OpenMA({ bearer: cookieToken, activeTenantId: "tn_..." });
```

## License

MIT — see [LICENSE](https://github.com/open-ma/open-managed-agents/blob/main/LICENSE).
