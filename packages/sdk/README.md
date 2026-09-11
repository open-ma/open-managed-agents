# @openma/sdk

`@openma/sdk` composes the official Anthropic TypeScript SDK with OpenMA-only
extensions. It does not reimplement Managed Agents resources, pagination,
streaming, errors, or request behavior.

```bash
pnpm add @openma/sdk
```

```ts
import { OpenMA } from "@openma/sdk";

const client = new OpenMA({
  apiKey: process.env.OMA_API_KEY,
});

// The exact @anthropic-ai/sdk Managed Agents resource tree.
const agents = await client.beta.agents.list({ limit: 20 });

// OpenMA product extensions stay in their own namespace.
const available = await client.oma.models.list({
  provider: "deepseek",
});

const card = await client.oma.modelCards.create({
  model_id: "deepseek-fast",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  api_key: process.env.DEEPSEEK_API_KEY!,
});
```

## Object model

```ts
client.anthropic // the real @anthropic-ai/sdk client
client.beta      // the same object as client.anthropic.beta
client.oma       // typed /v1/oma/* extensions
client.oma.modelCards // typed Model Card CRUD
```

`client.beta` is an identity alias, not a wrapper. Official SDK types, cursor
pages, SSE streams, retries, request options, and error classes therefore pass
through unchanged.

The provider-discovery endpoint intentionally remains separate from the
official models endpoint:

```ts
await client.beta.models.list();                 // executable tenant cards
await client.oma.models.list({ provider: "openai" }); // Pi provider catalog
```

These are intentionally different catalogs:

| Resource | Meaning | Credentials in request |
|---|---|---|
| `client.beta.models` | The active Model Cards this tenant can execute, projected into the official Managed Agents Model shape | Never |
| `client.oma.models` | Models known by Pi for one built-in provider; useful while creating a card | Never on the SDK-first path |
| `client.oma.modelCards` | Tenant-scoped provider routing, encrypted credential, and Pi model metadata | Only create/rotate accepts `api_key` |

`oma.models.list({ apiKey })` is retained only for 0.x compatibility with the
old Anthropic/OpenAI live-discovery endpoint. New clients should not forward a
provider credential just to browse Pi's catalog.

## Agent model controls

Managed Agents model controls belong to an **Agent version**, not to a Model
Card. A Session pins an Agent version and inherits its controls:

```ts
await client.beta.agents.create({
  name: "fast-researcher",
  model: {
    id: "claude-prod",       // Model Card model_id
    effort: { type: "high" },
    speed: "fast",
    inference_geo: "us",
  },
});
```

| Managed field | Runtime behavior |
|---|---|
| `model.id` | Resolves the tenant Model Card, then its wire model and Pi provider. |
| `model.effort` | Maps to Pi `thinkingLevel`. Pi normalizes unsupported levels to the nearest level supported by that model (for example DeepSeek `medium` becomes `high`). |
| `model.speed` | `standard` leaves Pi defaults unchanged. `fast` maps to Anthropic fast mode or OpenAI priority service tier. Other Pi APIs fail explicitly instead of silently ignoring it. |
| `model.inference_geo` | Accepted, versioned, and returned in the official shape. OpenMA currently does not use it for provider/region routing. |

`speed` is request policy and therefore must not be placed in `pi_config`.
Whether a specific effort level is usable is discoverable through
`client.beta.models`; capability flags are conservatively derived from Pi's
model metadata.

## Pi-backed Model Cards

`provider` is an open Pi provider id (`anthropic`, `openai`, `deepseek`,
`openrouter`, and so on). Migration aliases `ant`, `oai`,
`ant-compatible`, and `oai-compatible` remain accepted. For a custom provider,
set `base_url` and provide `pi_config.api` so Pi can choose the wire protocol.

`pi_config` exposes only Pi's serializable Model metadata:

```ts
await client.oma.modelCards.create({
  model_id: "private-vllm",
  provider: "my-vllm",
  model: "org/model-1",
  base_url: "https://llm.example/v1",
  api_key: process.env.PRIVATE_LLM_KEY!,
  pi_config: {
    api: "openai-completions",
    name: "Private model",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
});
```

Card identity (`model_id`), wire model (`model`), provider, endpoint, headers,
and credential remain first-class Card fields and cannot be overridden through
`pi_config`. List/retrieve responses never return the credential, only its
preview. A create probe returning `unsupported_provider` means the legacy
six-second probe could not exercise that Pi provider; it does not mean Pi
cannot execute the card.

Extensions without a typed resource yet can use the guarded escape hatch. It
accepts only `/v1/oma/*` paths and still runs through the official transport:

```ts
const stats = await client.oma.request<{ agents: number }>({
  method: "get",
  path: "/v1/oma/stats",
});
```

## Configuration

All official `@anthropic-ai/sdk` client options are accepted. OpenMA defaults
`baseURL` to `https://openma.dev` and adds one optional workspace header:

```ts
new OpenMA({
  apiKey: "oma_...",
  baseURL: "https://openma.example",
  activeTenantId: "tn_...",
});
```

`baseUrl` and `bearer` remain deprecated migration aliases for `baseURL` and
`authToken`. Browser callers must explicitly use the official
`dangerouslyAllowBrowser` option and should only do so with an appropriate
cookie/token security model.

## Migrating from 0.x

| 0.x | 1.x |
|---|---|
| `client.agents` | `client.beta.agents` |
| `client.sessions` | `client.beta.sessions` |
| `client.environments` | `client.beta.environments` |
| `client.memoryStores` | `client.beta.memoryStores` |
| `client.dreams` | `client.beta.dreams` |
| `baseUrl` | `baseURL` |
| `bearer` | `authToken` |
| `OpenMAError` | official `APIError` subclasses from `@anthropic-ai/sdk` |

The 1.x methods use the official SDK parameter and return shapes. There are no
top-level Managed resource aliases because keeping the old names with different
method semantics would create silent migration bugs.
