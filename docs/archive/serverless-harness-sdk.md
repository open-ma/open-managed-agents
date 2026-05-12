# Serverless Harness SDK

> Users write a `.ts` file, deploy it, and their custom harness replaces DefaultHarness — no infrastructure to manage.

## The Problem

The platform already supports pluggable harnesses via `HarnessInterface` + `resolveHarness(name)`. But today, custom harness code must be compiled into the agent worker at build time by us. There's no self-service path for users to deploy their own harness logic.

The goal: **make the harness hot-swappable, serverlessly.**

## Design Space: Three Approaches Evaluated

### Approach A: Dynamic Code Loading (Rejected)

```
User .ts → compile → store in KV/R2 → SessionDO eval() at runtime
```

The idea: treat harness code like data. Store compiled JS in KV, load it dynamically when SessionDO needs to instantiate a harness.

**Why it doesn't work:**
- Cloudflare Workers don't support `dynamic import()` from strings
- `eval()` / `new Function()` are disabled by default in Workers (requires `unsafe-eval` compat flag)
- Security model breaks down — user code runs in the same isolate as SessionDO with access to all bindings (KV, R2, DO storage)
- No dependency resolution — user's harness can't `import` from `ai`, `@anthropic-ai/sdk`, etc. without bundling everything into the eval'd string

### Approach B: Harness as Separate Worker (Rejected)

```
User .ts → build as standalone Worker → SessionDO calls it via Service Binding
```

The idea: each custom harness is its own Cloudflare Worker. SessionDO sends `HarnessContext` over HTTP, harness worker runs the loop, sends events back.

**Why it doesn't work:**
- `HarnessContext` contains live objects that can't be serialized: `runtime.sandbox` (function references to container), `runtime.broadcast` (WebSocket push), `runtime.history` (SQLite-backed store)
- Would require building an RPC layer: harness calls `sandbox.exec()` → HTTP request back to SessionDO → SessionDO calls container → response back to harness worker
- Every tool call becomes 2 extra network hops (harness→SessionDO→container→SessionDO→harness)
- Latency multiplies: a 50-step agent loop with 2 tool calls per step = 200 extra round trips
- Complexity explosion for marginal benefit

### Approach C: Compile-Time Injection (Selected)

```
User .ts → inject into agent worker template → esbuild → wrangler deploy
```

The idea: use the exact same deployment pipeline that already exists for environments. The user's harness `.ts` file is imported into the worker entry point at build time, registered in the harness registry, and deployed as part of the agent worker.

**Why this wins:**
- **Zero architecture changes** — `HarnessContext` stays as-is, all references (`sandbox`, `broadcast`, `history`) remain local function calls in the same isolate
- **Reuses existing pipeline** — environment deployment already does "generate wrangler config → esbuild → wrangler deploy"
- **Security by default** — user code runs inside Workers' V8 sandbox, same isolation as any Worker. No `eval`, no dynamic import, no access beyond what `HarnessContext` provides
- **Zero overhead** — harness and SessionDO share an isolate, no network hops for tool calls
- **Familiar mental model** — "change code → deploy → live" is the same as every Cloudflare Worker, Vercel function, or Deno Deploy script

The trade-off — redeploying the worker on harness changes — is the same trade-off every serverless platform makes. Users already accept this for Cloudflare Workers, Lambda functions, etc.

## How It Works

### Build-time flow

```
┌──────────────────────────────────────────────────────────────┐
│  1. User writes my-harness.ts implementing HarnessInterface  │
│  2. CLI: oma deploy --harness my-harness.ts --agent agent_x  │
│  3. Platform reads agent config → finds environment worker   │
│  4. Injects user's harness into worker entry point:          │
│                                                              │
│     import UserHarness from "__USER_HARNESS__";  // esbuild  │
│     registerHarness("custom", () => new UserHarness());      │
│                                                              │
│  5. esbuild bundles worker + harness together                │
│  6. wrangler deploy updates the worker                       │
│  7. Agent config updated: agent.harness = "custom"           │
└──────────────────────────────────────────────────────────────┘
```

### Runtime flow (unchanged)

```
user.message arrives
       ↓
SessionDO.drainEventQueue()
       ↓
resolveHarness(agent.harness)  →  returns user's harness instance
       ↓
harness.run(ctx)  ←  same HarnessContext as today
       ↓
User's custom loop runs with full access to:
  - ctx.runtime.history    (event log)
  - ctx.runtime.sandbox    (container execution)
  - ctx.runtime.broadcast  (WebSocket push)
  - ctx.tools              (platform-prepared tools)
  - ctx.model              (resolved language model)
  - ctx.systemPrompt       (base system prompt)
```

No new infrastructure. No RPC layer. No serialization boundary. The harness just runs.

## The SDK

### Package: `@open-managed-agents/sdk`

The SDK is thin — it re-exports the interfaces users need and provides convenience helpers. It does NOT wrap or abstract away `HarnessContext`; users get direct access to platform primitives.

```typescript
// --- Core: what users implement ---
export { HarnessInterface, HarnessContext, HistoryStore, SandboxExecutor } from "./interface";

// --- Convenience: defineHarness() wraps a function into HarnessInterface ---
export function defineHarness(config: {
  name: string;
  run: (ctx: HarnessContext) => Promise<void>;
}): { name: string; create: () => HarnessInterface };

// --- Re-exports: tools the harness uses inside run() ---
export { generateText, streamText, stepCountIs } from "ai";

// --- Batteries included: optional platform strategies ---
export { SummarizeCompaction } from "./compaction";
export { withRetry } from "./retry";
export { defaultStepHandler } from "./step-handler";
```

### User's harness file

```typescript
// my-harness.ts
import {
  defineHarness,
  generateText,
  stepCountIs,
  SummarizeCompaction,
} from "@open-managed-agents/sdk";

export default defineHarness({
  name: "research-harness",

  async run(ctx) {
    // 1. Read history from the platform's event log
    let messages = ctx.runtime.history.getMessages();

    // 2. My compaction strategy: keep web_search results, compress everything else
    const compaction = new SummarizeCompaction({ keepToolNames: ["web_search"] });
    if (compaction.shouldCompact(messages)) {
      messages = await compaction.compact(messages, ctx.model);
    }

    // 3. My caching strategy: cache breakpoint on last 3 messages
    for (let i = Math.max(0, messages.length - 3); i < messages.length; i++) {
      (messages[i] as any).providerMetadata = {
        anthropic: { cacheControl: { type: "ephemeral" } },
      };
    }

    // 4. Run the loop — tools, sandbox, broadcast are all platform-provided
    const result = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt + "\n\nAlways cite sources with URLs.",
      messages,
      tools: ctx.tools,
      stopWhen: stepCountIs(50),
      onStepFinish: async ({ text, toolCalls, toolResults }) => {
        // Broadcast events to WebSocket clients
        if (text) {
          ctx.runtime.broadcast({
            type: "agent.message",
            content: [{ type: "text", text }],
          });
        }
        // ... handle tool events
      },
    });

    // 5. Report usage
    if (result.usage && ctx.runtime.reportUsage) {
      await ctx.runtime.reportUsage(result.usage.inputTokens, result.usage.outputTokens);
    }
  },
});
```

### Deploy

```bash
# One command. Platform handles everything.
oma deploy --harness my-harness.ts --agent agent_abc123

# What happens behind the scenes:
# 1. Validates my-harness.ts exports a valid defineHarness() result
# 2. Fetches agent config → finds bound environment worker
# 3. Injects harness into worker build
# 4. esbuild + wrangler deploy
# 5. Updates agent.harness = "research-harness"
```

## Why This is Different from Vercel/Cloudflare Agent SDKs

The industry comparison is instructive for what we are NOT building:

| SDK | What it gives you | What you manage |
|---|---|---|
| Vercel AI SDK (`ToolLoopAgent`) | Inference loop | Everything else: state, sandbox, deployment, tools |
| Cloudflare Agents SDK (`Agent` class) | Durable Object + state | Tool execution, sandbox, memory, credentials |
| **Our SDK** (`defineHarness`) | Nothing extra — you get less | Nothing — platform manages everything |

The key insight: **our SDK is subtractive, not additive.**

Other SDKs give you building blocks and say "compose them." Our SDK gives you a fully-running agent platform and says "replace just the brain." The user's `.ts` file is the thinnest possible layer — pure strategy, zero infrastructure:

- No state management (SessionDO owns the event log)
- No sandbox provisioning (platform handles containers)
- No tool registration (platform builds tools from agent config)
- No WebSocket handling (platform broadcasts events)
- No crash recovery logic (platform catches errors, rebuilds from event log)
- No credential management (vault is platform-level, never touches harness)

The harness is a **pure function** from `(history, tools, model) → events`. Everything else is the platform's job.

## Implementation Plan

### Phase 1: SDK Package

Create `packages/sdk/` that exports the harness interface + helpers. This is mostly re-exporting what already exists in `apps/agent/src/harness/` — making it a proper public API.

### Phase 2: Build Pipeline

Extend `scripts/deploy.sh` (or create `scripts/deploy-harness.sh`) to:
1. Accept a user `.ts` file path
2. Copy it into the agent worker source tree with an esbuild alias
3. Generate the registration code (`registerHarness(name, factory)`)
4. Run the existing esbuild + wrangler deploy pipeline

### Phase 3: CLI

Create `packages/cli/` with:
- `oma init` — scaffold a harness `.ts` file from template
- `oma dev` — local dev with miniflare + mocked sandbox
- `oma deploy --harness <file> --agent <id>` — the one-command deploy
- `oma logs <session-id>` — stream events via WebSocket

### Phase 4: Local Dev Experience

- `oma dev` spins up miniflare with SessionDO + InMemoryHistory + local shell sandbox
- Hot reload: watch user's `.ts` file, re-bundle on change
- Local console UI connects via WebSocket for real-time event streaming

## Open Questions

1. **Multi-harness per worker**: Should one worker support multiple custom harnesses (via registry), or is it one harness per worker deployment? One-per-worker is simpler but means N deployments for N harnesses.

2. **Harness versioning**: When a user deploys a new harness version, existing running sessions continue with the old code (they're mid-loop in the DO). New sessions get the new code. Is this acceptable, or do we need explicit version pinning per session?

3. **Dependency management**: User's harness can import from `ai`, `@anthropic-ai/sdk`, etc. because those are bundled in the worker. But what if they want to import their own npm packages? Do we run `npm install` during the build step, or restrict to platform-provided dependencies?

4. **Testing**: How do users test their harness locally before deploying? The `oma dev` experience needs to be good enough that users rarely deploy broken harnesses. This means providing mock implementations of `HistoryStore`, `SandboxExecutor`, and `broadcast`.

## References

- [Architecture: Meta-Harness Design](./architecture.md) — the three-layer architecture this builds on
- [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) — Anthropic's brain/hands separation
- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — the deployment target
- [esbuild](https://esbuild.github.io/) — the bundler used for compile-time injection
