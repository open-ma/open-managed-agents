# OpenAI Agents semantic adapter

This package maps the pinned `openai@7.15.0` Agents API onto OpenMA's existing
application ports. The HTTP router lives in `openai-agents-api`; the independent
SDK request inventory lives in `openai-agents-sdk-audit`.

It does not own a database, Session replica, Turn table, Item table, executor,
or filesystem. Native resources remain authoritative.

## Mapping

| OpenAI surface | Existing native source |
| --- | --- |
| Saved / inline Agent | Agent and immutable Session agent snapshot |
| Environment Template | Environment configuration |
| Session Environment | Session identity and the connected SandboxPort |
| Session, Turn, Item, required actions | Session, initial input and ordered committed events |
| Subagent history | Session thread / lane events |
| Vault and Credential | Existing encrypted credential services |
| Live environment files | Actual sandbox binary writes and file enumeration |
| Artifact | Immutable native File with explicit session / environment / turn / path origin |

`resources.ts` translates CRUD and pagination. Unmatched configuration is retained
in the resource's existing metadata; a native edit takes precedence over a stale
name hint. Confidential environment and session configuration uses the existing
secret sealer. Session overrides replace entire object or array fields, as the
official configuration contract requires.

`session-mapping.ts` prepares native commands and reconstructs the configuration
view. The runtime capability callback runs before creating native resources.
Storing a saved configuration does not certify that a selected runtime can enact
it; unsupported execution settings must fail explicitly at session creation.

`projection.ts` is a pure replay function. Stable input and event identities
determine Turn and Item identities. Steering and function-result continuation
remain in the same unfinished Turn; a later input opens a new Turn after a
terminal result. Cancellation and terminal failure take precedence over a
runner's final idle event. Unknown usage stays `null`.

Subagent projection consumes the existing native thread events and
`@openma/common` agent WorkItem lifecycle, including parent correlation and
identity refinement. Six coordination item types are derived from real tool
calls. A completed child turn keeps the subagent available; closing and reopening
change its lifecycle without inventing a new turn when no input was sent.

`sessions.ts` rebuilds views from native history on every read. Event occurrence
order comes from committed `{revision,index}` positions; timestamp / ID sorting
is used only where the external pagination contract requires it. Legacy history
without reliable positions returns `409 history_order_unavailable` on direct
projection and is omitted from the session collection. Other errors are surfaced.
SSE subscriptions use transient replay state; disconnecting does not cancel work.
Text-done events contain the durable full text, without invented token deltas.

Input idempotency uses native persisted event identities. A matching retry returns
the original acceptance without redispatch. Reusing a key with different input
returns 409. Function-result validation also binds to the history's Session
revision, so competing submissions cannot both consume the same pending call.
Hosts must combine this with durable execution admission / wakeup; the Node host
enables the existing transactional execution outbox. An adapter that dispatches
only after persistence cannot recover a lost dispatch solely by replaying a key.

## Node composition

The Node host mounts this adapter at `/openai/v1`, authenticates with existing
OpenMA credentials, and resolves ports for that authenticated workspace.

With `agent.multi_agent.enabled: true`, the Node harness registers creation,
message, wait, interrupt, close and resume tools backed by native Session Threads.
The compatibility baseline is **single-level subagent execution, aligned with
Codex multi-agent V1 defaults**: the main agent delegates to children, and children
do not receive further delegation tools. Recursive execution is outside this
baseline; projection still preserves nested relationships supplied by an upstream
harness. This execution baseline is distinct from the `agents=v1` HTTP version.
Child histories remain independent, share the parent sandbox, and retain MCP and
search configuration. Client function tools stay on the main agent. Child work
remains under the parent's execution fence, and native events supply replay and
query state.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENMA_API_KEY,
  baseURL: "http://localhost:8787/openai/v1", // use your Node server's port
});

const session = await client.beta.agents.sessions.create({
  agent: { model: "your-configured-model", instructions: "Be concise." },
  environment: { type: "none" },
  input: "Hello",
});
```

`none` bypasses physical sandbox creation and preparation. Hosted file operations
use the connected provider; a disconnected environment returns an error instead
of writing into a compatibility-layer filesystem. Provider capability limits and
the distinct levels of evidence are recorded in
[the implementation audit](../../docs/openai-agents-compatibility-status.md).

## Verification

Run from the repository root:

```sh
pnpm run test:openai-agents
pnpm run test:openai-agents:node
```

The package tests invoke the real SDK through the complete Hono router and native
application services. SQL certification uses actual SQLite migrations and a fresh
connection to verify reconstruction, input admission, pending function actions,
cancellation, idempotency and SSE. A controlled executor emits native facts in that
suite; actual Node process execution is tested separately in `apps/main-node`.
See the [upstream test audit](../../docs/openai-agents-upstream-test-audit.md) for
the distinction between SDK contract tests, Codex harness integration tests and
live model smoke tests, along with the latest local Node results.
