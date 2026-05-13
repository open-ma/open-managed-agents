// @open-managed-agents/integrations-core
//
// Abstract interfaces for the integration layer. No runtime dependencies —
// this package must be instantiable in pure Node, browser, or workerd alike.
//
// Implementations (e.g. packages/linear) depend ONLY on the ports defined here.
// Concrete adapters (e.g. packages/integrations-adapters-cf) implement the
// ports against specific runtime primitives (D1, KV, service bindings).

export * from "./domain";
export * from "./ports";
export * from "./persistence";
export * from "./provider";
export * from "./avatars";
export * from "./install-bridge";
