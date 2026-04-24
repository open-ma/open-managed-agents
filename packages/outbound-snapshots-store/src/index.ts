// Public surface of @open-managed-agents/outbound-snapshots-store.
//
//   - types       : OutboundSnapshot, DEFAULT_OUTBOUND_SNAPSHOT_TTL_SECONDS
//   - errors      : reserved for future typed errors (currently empty)
//   - ports       : abstract dependencies the service requires
//   - service     : OutboundSnapshotService (pure pass-through, port-only deps)
//   - adapters    : Cloudflare-specific implementations + factory
//
// Callers in apps/agent (SessionDO + outbound worker) normally only need:
//   import { createCfOutboundSnapshotService } from "@open-managed-agents/outbound-snapshots-store";
// Tests use:
//   import { createInMemoryOutboundSnapshotService } from "@open-managed-agents/outbound-snapshots-store/test-fakes";

export * from "./types";
export * from "./errors";
export * from "./ports";
export { OutboundSnapshotService } from "./service";
export type { OutboundSnapshotServiceDeps } from "./service";

// Re-export the CF factory at the top level so callers don't have to know
// about the adapters subdir.
export { createCfOutboundSnapshotService, KvOutboundSnapshotRepo } from "./adapters";
