// No typed errors needed — every method either succeeds, returns null (get on
// missing key), or returns a count (deleteAllForSession). Mirrors the
// best-effort delete semantics of the previous KV-direct call sites in
// apps/main/src/routes/sessions.ts (a missing key is a no-op delete, not an
// error).
//
// Kept as a real module (not deleted) so the public surface mirrors the
// credentials-store layout (`export * from "./errors"` in index.ts). Future
// typed errors land here.

export {};
