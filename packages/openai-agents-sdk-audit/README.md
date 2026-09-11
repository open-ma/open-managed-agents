# OpenAI Agents SDK audit

This is the external contract inventory for adapting OpenMA to the published
`openai@7.15.0` `client.beta.agents` surface. It complements the existing
`managed-agents-api/test/*.contract.test.ts` tests that invoke Anthropic's SDK.

The audit discovers **43 public SDK methods** and executes **44 scenarios**:
one per method plus the streaming overload of `sessions.create`. The
`sessions.stream` convenience helper is included as a composed operation:
retrieve the idle session, subscribe to SSE, and then submit input. It is not
an extra HTTP endpoint.

## Run

From the repository root:

```sh
pnpm --filter @open-managed-agents/openai-agents-sdk-audit run audit
pnpm --filter @open-managed-agents/openai-agents-sdk-audit test
pnpm --filter @open-managed-agents/openai-agents-sdk-audit run audit --json
```

No API key, model provider, sandbox, server, or network connection is used.
The real published SDK runs with an in-process `fetch` capture transport.
All names, keys, credentials, and payloads in the baseline are synthetic.

## What is measured

`src/scenarios.mjs` supplies reviewed, explicit expected HTTP methods and
paths. The SDK itself serializes the calls; the transport never rewrites
paths, query parameters, bodies, or headers. The audit checks:

- Every public resource method, including nested subagent turns and items.
- `/v1` base URL handling, `OpenAI-Beta: agents=v1`, bearer authentication,
  JSON bodies, nested path arguments, query parameters, and media types.
- Input-event idempotency keys move into the header, outside the JSON body.
- Cursor pagination (`after`) and environment-file pagination (`page`).
- SDK parsing of UTF-8 SSE across arbitrary chunk boundaries, comments,
  error frames, 204 responses, typed HTTP errors, and binary artifact bytes.
- The helper's subscription-before-input request order.

Here, nested subagent turns and items describe resource paths, not a runtime
recursion claim. The `OpenAI-Beta: agents=v1` protocol version is also distinct
from the adapter's chosen Codex multi-agent V1 default, single-level execution
baseline; see the [compatibility statement](../../docs/openai-agents-compatibility-status.md).

`baseline.json` records the requests produced by every scenario. Tests and the
CLI fail when the measured baseline changes or the installed SDK introduces a
method without a scenario. SDK version changes also require explicit review.
After reviewing an intentional contract change, regenerate the baseline with:

```sh
pnpm --filter @open-managed-agents/openai-agents-sdk-audit run audit --write-baseline
```

The source inventory is pinned; this command does not discover newer versions
on npm or silently update dependencies.

## Compatibility evidence

Every operation currently records `openmaCompatibility: "unverified"` and
`compatibilityEvidence: []`. A passed SDK audit establishes a known external
request contract. It does **not** establish server-side implementation,
response schema validation, runtime execution, or feature completeness.
The SDK accepts unvalidated JSON responses, so generic resource captures
deliberately use an empty object and make no response-conformance claim.
Pagination tests likewise isolate envelope behavior, not resource schemas.
The stream helper audit stops after its first event; completion, cancellation,
reconnection, and automatic tool handling need server integration tests.

The implementation layers now live in `openai-agents-api` and
`openai-agents-compat`, with Node process tests in `apps/main-node`. Their
[compatibility evidence](../../docs/openai-agents-compatibility-status.md) is
recorded separately from this immutable upstream request baseline. One scenario
per method is not exhaustive request-union or field coverage.

## Sources

- Published package: `openai@7.15.0`, `src/resources/beta/agents/**/*.ts`
- Helper: `src/lib/agents/agent-session-stream.ts`
- Pagination and error transport: `src/core/pagination.ts`, `src/core/error.ts`
- [OpenAI Agents API guide](https://developers.openai.com/api/docs/guides/agents-api/overview)
- [Official JavaScript SDK](https://github.com/openai/openai-node)

Notable route differences from Claude Managed Agents: session endpoints are
under `/v1/agents/sessions`; vault endpoints remain under `/v1/vaults`; reusable
environment configuration lives at `/v1/agents/environments/templates`; updates
use POST. Turns, items, artifacts, and live events are distinct resources.
