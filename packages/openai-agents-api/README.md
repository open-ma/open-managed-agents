# OpenAI Agents HTTP adapter

`buildOpenAIAgentsProtocolApi(port)` implements the HTTP boundary audited against
`openai@7.15.0`. It registers all 42 public HTTP operations used by the SDK's
43 methods. The `sessions.stream` SDK helper composes three existing operations.
Production code does not import the OpenAI SDK.

The host authenticates the caller, selects the workspace and supplies an
`OpenAIAgentsProtocolPort`. The port receives the operation name, snake_case path
parameters, validated JSON body, query values, request headers and an abort
signal. The application bridge lives in `@open-managed-agents/openai-agents-compat`.

## Contract coverage

- Saved agents; environment templates, live environments and files; vaults and
  credentials; sessions, subagents, turns, items, artifacts and events.
- SDK-derived request and response contracts, including every tool, environment,
  credential, item, output-format and event union exposed by the pinned SDK.
- No silently discarded request fields. Documented metadata/name limits and
  required model selection are checked in addition to structural SDK types.
- ID-based `after` pagination and opaque `page` pagination for environment files.
  Repeated `status[]` query parameters remain an array; duplicate scalar queries
  fail validation.
- `OpenAI-Beta: agents=v1`, event submission with `Idempotency-Key`, 204 responses,
  byte-preserving artifact download and OpenAI error envelopes.
- Validated SSE event payloads and IDs. Disconnecting aborts only the subscription;
  durable cancellation uses the explicit input event. Invalid application output
  produces a sanitized server error.

The earlier `buildOpenAISessionRoutes` and `buildOpenAIVaultRoutes` remain exported
for existing callers and their contract tests. New composition uses the complete
protocol router.

## Verification

```sh
pnpm --filter @open-managed-agents/openai-agents-api test
pnpm --filter @open-managed-agents/openai-agents-api typecheck
pnpm --filter @open-managed-agents/openai-agents-sdk-audit run audit
```

The router tests replay the independent, hand-reviewed SDK audit request cases,
exercise response validation and pagination, and use the actual SDK for SSE and
file pagination. Application/resource/runtime evidence is tested separately in
the compatibility package; a protocol test alone does not establish that a
provider executes every accepted setting.

## Regenerating structural contracts

`src/sdk-contracts.generated.ts` contains 150 public contract roots and their
shared structural descriptors. The generator reads public SDK TypeScript
declarations through the TypeScript compiler API. It refuses a package version
other than 7.15.0. TypeScript 5.x and the SDK are generation inputs only.

```sh
TS_COMPILER_PATH=/path/to/typescript/lib/typescript.js node packages/openai-agents-api/scripts/generate-sdk-contracts.mjs /path/to/openai/package
```

Review upstream SDK changes through the SDK audit before updating this version
gate or the generated contracts. `full-contracts.ts` contains semantic bounds
not encoded in TypeScript; `full-operations.ts` records the public route mapping.
