// @open-managed-agents/oma-cap-adapter
//
// L3 adapter wiring @open-managed-agents/cap into OMA's vault stack.
// Used by:
//   - apps/main mcp-proxy: resolves cap_cli credentials at outbound time
//   - apps/main oauth routes: stores acquired tokens via Resolver.store

export { OmaVaultResolver, encodePrincipal } from "./resolver";
export type { OmaResolverServices } from "./resolver";
