// @open-managed-agents/api-types
//
// Wire-format DTOs for the OMA platform: AgentConfig, SessionMeta, SessionEvent,
// ContentBlock, MemoryItem, FileRecord, etc. Pure types — zero workspace
// dependencies, no Cloudflare bindings, safe to import from CLI/console/server.
//
// Anything importing only types should depend on this package, not @oma/shared.

export * from "./types";
