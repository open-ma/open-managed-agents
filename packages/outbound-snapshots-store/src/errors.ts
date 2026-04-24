// Outbound snapshots are an internal MITM-side cache — there are no
// user-facing error paths to surface (callers either get a snapshot or null,
// and write paths are best-effort). This file is intentionally empty so the
// package layout matches the credentials-store / memory-store template; add
// typed errors here if a future caller needs to map them to HTTP status codes.
export {};
