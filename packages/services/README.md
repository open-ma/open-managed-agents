# @open-managed-agents/services

The single canonical surface for every platform-agnostic service in OMA.

## What this package is

A thin wiring layer that:

1. Defines the `Services` interface — one property per store package (credentials, memory, sessions, vaults, files, evals, model-cards, …)
2. Provides factories that construct one of these from a runtime environment (`buildCfServices(env)`, future `buildNodeServices(opts)`, etc.)
3. Exposes a Hono middleware that puts the container on `c.var.services`

Stores live in their own packages (`packages/<name>-store`); this package only wires them up.

## Why it exists

OMA started as a Cloudflare Workers app. Each route did:

```ts
import { createCfXxxService } from "@open-managed-agents/xxx-store";

app.post("/whatever", async (c) => {
  const service = createCfXxxService(c.env);
  return c.json(await service.method(...));
});
```

That tied every route to Cloudflare bindings. To support self-hosting on Postgres / SQLite / wherever, we'd have had to grep for `createCfXxxService` across N route files and mechanically replace each. Fragile.

This package collapses the wiring decision to **one place**: the factory function. Routes only see the abstract `Services` interface.

```ts
// packages/services/src/index.ts
export interface Services {
  credentials: CredentialService;
  memory: MemoryStoreService;
  // ... etc
}

export function buildCfServices(env: Env): Services { /* CF impls */ }

// future:
export function buildNodeServices(opts: { pg: pg.Pool }): Services { /* PG impls */ }
```

Routes:

```ts
app.post("/whatever", async (c) => c.json(
  await c.var.services.credentials.create({ /* ... */ })
));
```

To swap deployment target = swap one factory call in `apps/main/src/index.ts`. Routes don't change.

## Three wiring patterns (use whichever fits the call site)

### 1. HTTP routes — Hono middleware

Top of `apps/main/src/index.ts`:

```ts
import { servicesMiddleware } from "@open-managed-agents/services";

app.use("/v1/*", servicesMiddleware);
```

Then any route handler reads `c.var.services.X.method(...)`.

Routes must declare the service-bearing variable in the Hono generic:

```ts
import type { Services } from "@open-managed-agents/services";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();
```

### 2. Outside Hono (DO classes, sandbox-default outbound, cron) — direct factory

```ts
import { buildCfServices } from "@open-managed-agents/services";

class SessionDO {
  someMethod() {
    const services = buildCfServices(this.env);
    return services.credentials.refreshAuth(...);
  }
}
```

Same `Services` type, same factory — just no Hono context.

### 3. Tests — direct construction with in-memory ports

```ts
import {
  createInMemoryCredentialService,
} from "@open-managed-agents/credentials-store/test-fakes";
import {
  createInMemoryMemoryStoreService,
} from "@open-managed-agents/memory-store/test-fakes";

const services: Services = {
  credentials: createInMemoryCredentialService().service,
  memory: createInMemoryMemoryStoreService().service,
  // ... etc
};
```

(A future `buildTestServices()` helper could centralise this; today each test does it inline.)

## Adding a new service

When you add `packages/foo-store`:

1. **Implement** the store package (port interface, in-memory fake, D1 adapter, factory function `createCfFooService(env)`)
2. **Extend** `packages/services/src/index.ts`:
   ```ts
   import { FooService, createCfFooService } from "@open-managed-agents/foo-store";

   export interface Services {
     // ...existing
     foo: FooService;
   }

   export function buildCfServices(env: Env): Services {
     return {
       // ...existing
       foo: createCfFooService(env),
     };
   }
   ```
3. **Bump** `apps/main/package.json` and `apps/agent/package.json` to depend on `@open-managed-agents/foo-store` (workspace:*)
4. **Use it**: routes read `c.var.services.foo.method(...)`. No imports from `foo-store` needed in route files.

That's it. No grep-and-replace across routes when you change deployment.

## self-host path

Today only `buildCfServices` exists. To self-host on Postgres:

1. Each store package adds a Postgres adapter alongside its CF adapter (`packages/foo-store/src/adapters/pg-foo-repo.ts`)
2. Each store exports a `createPgFooService(pool)` factory
3. This package adds:
   ```ts
   export function buildNodeServices(opts: { pg: pg.Pool }): Services {
     return {
       credentials: createPgCredentialService(opts.pg),
       memory: createPgMemoryStoreService(opts.pg),
       // ...
     };
   }
   ```
4. `apps/main` entry picks the factory based on env: `process.env.STORE_BACKEND === 'pg' ? buildNodeServices(...) : buildCfServices(...)`

Routes and business code don't change at all. The `Services` interface is what they depend on; the factory just changes which adapter implements it.

The same applies to SQLite (single-binary self-host), MySQL (with the partial-UNIQUE caveat — see `docs/CFLESS.md` if it exists), or any other backend.

## Per-tenant routing is an adapter-internal concern

A natural follow-up question: "what about per-tenant database isolation?" (one D1 / SQLite file per tenant for stronger boundaries, easier GDPR delete, no shared row blast-radius.)

**This package doesn't need any changes to support it.** Per-tenant routing is decided _inside each store's adapter_, not at the services-container layer.

The reason it works is a property of the port interfaces: every method already takes `tenantId` as the first argument (or top-level field on the input). That makes `tenantId` a routing key — adapters can choose to use it.

Today's adapter (shared D1):

```ts
// packages/credentials-store/src/adapters/d1-credential-repo.ts
export class D1CredentialRepo implements CredentialRepo {
  constructor(private readonly db: D1Database) {}
  async insert(input) {
    await this.db.prepare(`INSERT INTO credentials ...`)
      .bind(input.tenantId, ...).run();
  }
}
```

Future per-tenant D1 adapter (one D1 per tenant, resolver picks):

```ts
// packages/credentials-store/src/adapters/per-tenant-d1-credential-repo.ts
export class PerTenantD1CredentialRepo implements CredentialRepo {
  constructor(private readonly resolver: (tenantId: string) => D1Database) {}
  async insert(input) {
    const db = this.resolver(input.tenantId);
    await db.prepare(`INSERT INTO credentials ...`).bind(...).run();
    // tenant_id column can be dropped from per-tenant schema if desired
  }
}
```

Future self-hosted SQLite per-tenant (one .db file per tenant):

```ts
// packages/credentials-store/src/adapters/sqlite-per-tenant-credential-repo.ts
export class SqlitePerTenantCredentialRepo implements CredentialRepo {
  constructor(private readonly opener: (tenantId: string) => Database) { /* ... */ }
}
```

The factory layer picks an adapter based on deployment intent:

```ts
// packages/credentials-store/src/adapters/index.ts
export function createCfCredentialService(env: Env): CredentialService {
  return new CredentialService({ repo: new D1CredentialRepo(env.AUTH_DB) });
}

export function createCfPerTenantCredentialService(opts: {
  resolver: (tenantId: string) => D1Database
}): CredentialService {
  return new CredentialService({ repo: new PerTenantD1CredentialRepo(opts.resolver) });
}
```

`Services` and `buildCfServices` in this package are completely unaware of per-tenant vs shared. They never need to be — that's the win.

### Mixed deployment is supported

Each store can independently choose its routing model. Credentials might benefit most from per-tenant isolation (secrets density), while sessions/memory stays shared (high-volume reads):

```ts
export function buildCfMixedServices(env: Env, opts: {
  credResolver: (tenantId: string) => D1Database;
}): Services {
  return {
    credentials: createCfPerTenantCredentialService({ resolver: opts.credResolver }),
    memory: createCfMemoryStoreService(env),       // shared
    sessions: createCfSessionService(env),         // shared
    // ...
  };
}
```

### Why per-tenant routing isn't done today

CF D1 currently doesn't have ergonomic dynamic binding (each D1 is a static `wrangler.toml` entry; HTTP API works but adds RTT cost). The per-tenant model becomes natural in:

- **Self-hosted SQLite** — one `.db` file per tenant is trivial
- **Postgres with row-level security per schema** — possible but heavy
- **Future CF capability** — if D1 introduces dynamic binding lookup

The interfaces are ready when you are.

## Anti-patterns

- **Don't import `createCfXxxService` from a route file.** Use `c.var.services.xxx`. The whole point of this package is to centralise the factory call.
- **Don't add a service whose port leaks D1/CF types.** The port (in `packages/<store>-store/src/ports.ts`) must be runtime-agnostic. If your method signature mentions `D1Database` or `KVNamespace`, you've broken the abstraction.
- **Don't add a global singleton.** The middleware constructs `Services` per request (it's cheap — each `createCfXxxService` is a thin wrapper). If you find yourself reaching for a module-level cache, ask whether the service itself should hold state internally.
- **Don't conditionally include services.** Every property on `Services` must be present in every factory's output (use Noop adapters for genuinely-optional infra). Optional service makes routes branch on `if (services.x)` which defeats the abstraction.
