/**
 * Daemon-side ACP agent registry — merges the official ACP registry with
 * OMA's static overlay, exposes a sync `which`-style detector.
 *
 * Two layers:
 *   - **overlay** (known-agents.ts): hand-curated entries OMA needs on
 *     top — legacy id aliases, agents the official registry doesn't
 *     carry (hermes, openclaw). Pure data, browser-safe.
 *   - **official** (registry-fetch.ts): live JSON from
 *     cdn.agentclientprotocol.com, fetched once at daemon startup,
 *     cached to disk. Node-only (uses fetch + fs).
 *
 * Detection rule (post-A2): only entries whose spec.command resolves on
 * $PATH count as detected. For npx-based entries, additionally require
 * the package to be globally installed — `npx` itself is always on PATH
 * with Node, so the bare `which npx` check would lie and report 20+
 * agents as available even though their packages aren't installed.
 *
 * Anything not detected MUST NOT appear in the Console. The user's
 * mental model: "if I haven't installed it, it's not there." No
 * teasers, no install-needed groups in the dropdown — they go install
 * via the cli first.
 *
 * Callers:
 *   - daemon: `await loadRegistry({ cachePath })` once at startup, then
 *     sync `getKnownAgents()` / `resolveKnownAgent()` everywhere
 *     downstream. detect/detectAll all use the merged cache.
 *   - browser / CF Worker: import OMA_OVERLAY_AGENTS + resolveOverlayAgent
 *     directly from known-agents.ts. They neither need nor should fetch
 *     the live registry on the hot path.
 *
 * Cold-start fallback: if loadRegistry never ran (or fetch + cache both
 * failed), getKnownAgents returns just the overlay. Daemon still spawns
 * agents whose ids appear in the overlay; unknown ids fail with the
 * usual "unknown ACP agent" error.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  OMA_OVERLAY_AGENTS,
  resolveOverlayAgent,
  type KnownAgentEntry,
} from "./known-agents.js";
import { fetchOfficialRegistry, mapOfficialAgent } from "./registry-fetch.js";

// Re-export so existing callers of `…/registry` keep working unchanged.
// New code should explicitly choose: overlay-only (sync, ./known-agents)
// or merged (async, here).
export {
  OMA_OVERLAY_AGENTS,
  resolveOverlayAgent,
  type KnownAgentEntry,
} from "./known-agents.js";
// Pre-A2 name kept for back-compat. Returns the OVERLAY only — daemons
// should call getKnownAgents() instead to see official entries too.
export { OMA_OVERLAY_AGENTS as KNOWN_ACP_AGENTS } from "./known-agents.js";

let _mergedCache: KnownAgentEntry[] | null = null;
let _npmGlobalCache: Set<string> | null = null;
let _uvToolCache: Set<string> | null = null;

/**
 * Fetch the official registry, merge with our overlay, cache the result
 * in module scope. Daemon should call this once at startup, before any
 * sync detect/resolve calls. Errors are swallowed and logged to stderr
 * — even a network-isolated daemon must keep working with overlay-only.
 *
 * Idempotent: subsequent calls with no `forceRefresh` return the cache.
 */
export async function loadRegistry(opts?: {
  cachePath?: string;
  ttlMs?: number;
  forceRefresh?: boolean;
}): Promise<KnownAgentEntry[]> {
  if (_mergedCache && !opts?.forceRefresh) return _mergedCache;
  let officialMapped: KnownAgentEntry[] = [];
  try {
    const reg = await fetchOfficialRegistry({ cachePath: opts?.cachePath, ttlMs: opts?.ttlMs });
    for (const o of reg.agents) {
      const m = mapOfficialAgent(o);
      if (m) officialMapped.push(m);
    }
  } catch (e) {
    process.stderr.write(
      `! ACP registry fetch failed (${(e as Error).message}); using OMA overlay only\n`,
    );
    officialMapped = [];
  }
  _mergedCache = mergeOverlay(officialMapped, OMA_OVERLAY_AGENTS);
  // Re-snapshot installed packages so npx/uvx-based detect calls
  // reflect current install state. Cheap (one subprocess per package
  // manager), once per refresh.
  _npmGlobalCache = snapshotNpmGlobal();
  _uvToolCache = snapshotUvTool();
  return _mergedCache;
}

/**
 * Return the merged registry. Synchronous: depends on loadRegistry()
 * having been awaited at daemon startup. Falls back to OVERLAY only
 * when not loaded — better than throwing, since overlay-known agents
 * (claude-acp, hermes, etc.) still spawn correctly.
 */
export function getKnownAgents(): readonly KnownAgentEntry[] {
  return _mergedCache ?? OMA_OVERLAY_AGENTS;
}

/**
 * Resolve an id (canonical or alias) against the merged registry. Sync.
 * Falls back to overlay-only when loadRegistry hasn't run.
 */
export function resolveKnownAgent(id: string): KnownAgentEntry | null {
  const list = getKnownAgents();
  for (const e of list) {
    if (e.id === id) return e;
    if (e.aliases?.includes(id)) return e;
  }
  return null;
}

/**
 * Merge official + overlay. Same-id entries: overlay wins for spec /
 * aliases, falls back to official for label / installHint / homepage if
 * overlay didn't set them. Overlay-only ids append.
 *
 * Order in the returned list: original official order first, then
 * overlay-only entries appended. This keeps the dropdown stable across
 * registry refreshes (official order is stable across runs because the
 * upstream registry is sorted).
 */
function mergeOverlay(
  official: KnownAgentEntry[],
  overlay: KnownAgentEntry[],
): KnownAgentEntry[] {
  const overlayById = new Map(overlay.map((e) => [e.id, e]));
  const seenOverlay = new Set<string>();
  const merged: KnownAgentEntry[] = [];
  for (const o of official) {
    const ov = overlayById.get(o.id);
    if (ov) {
      seenOverlay.add(o.id);
      merged.push({
        id: o.id,
        label: ov.label || o.label,
        spec: ov.spec, // overlay wins — usually carries our preferred binary
        installHint: ov.installHint || o.installHint,
        homepage: ov.homepage || o.homepage,
        aliases: ov.aliases,
        featured: ov.featured,
        wraps: ov.wraps,
        // Overlay's install wins when set (lets us pin a specific
        // package). When unset, fall back to whatever mapOfficialAgent
        // derived from the live registry — that's how codex-acp picks
        // up its per-platform archives without overlay duplicating
        // version-pinned URLs that bit-rot.
        install: ov.install ?? o.install,
      });
    } else {
      merged.push(o);
    }
  }
  // Append overlay-only (not in official) — hermes, openclaw today.
  for (const ov of overlay) {
    if (!seenOverlay.has(ov.id)) merged.push(ov);
  }
  return merged;
}

/** Reset module cache. Test-only. */
export function _resetRegistryCache(): void {
  _mergedCache = null;
  _npmGlobalCache = null;
  _uvToolCache = null;
}

/**
 * Returns the KnownAgentEntry whose binary is on $PATH, else `null`.
 * Accepts the canonical id OR any registered alias.
 *
 * For package-manager-launched entries (`spec.command` is `npx` / `uvx`),
 * additionally requires the package to actually be installed via that
 * manager — `npx` and `uvx` are always on PATH once Node / uv are
 * installed, so the bare `which` check would lie and report 20+ agents
 * as available even though their packages aren't. The package
 * specifier comes from spec.args[1] (npx, after `-y`) or spec.args[0]
 * (uvx, the bare package name).
 *
 * Intentionally Node-only — relies on `child_process.spawn`. Browsers
 * should call OMA_OVERLAY_AGENTS directly and check on the daemon side.
 */
export async function detect(id: string): Promise<KnownAgentEntry | null> {
  const entry = resolveKnownAgent(id);
  if (!entry) return null;
  if (!(await isOnPath(entry.spec.command))) return null;
  if (entry.spec.command === "npx" && !isNpxPackageInstalled(entry)) return null;
  if (entry.spec.command === "uvx" && !isUvxPackageInstalled(entry)) return null;
  return entry;
}

/**
 * npx-based entries: package specifier sits at spec.args[1] (mapped as
 * `["-y", "<package>@<version>", ...registry-args]`); strip the
 * trailing `@version` and check the cached `npm ls -g` snapshot.
 */
function isNpxPackageInstalled(entry: KnownAgentEntry): boolean {
  const pkgSpec = entry.spec.args?.[1];
  if (!pkgSpec) return false;
  // Scoped packages (`@scope/name`) keep the leading @, only the
  // trailing version-after-rightmost-@ should go.
  const lastAt = pkgSpec.lastIndexOf("@");
  const pkgName = lastAt > 0 ? pkgSpec.slice(0, lastAt) : pkgSpec;
  const cache = _npmGlobalCache ?? (_npmGlobalCache = snapshotNpmGlobal());
  return cache.has(pkgName);
}

/**
 * uvx-based entries: package specifier sits at spec.args[0] (mapped as
 * `["<package>@<version>", ...registry-args]`); strip version and
 * check the cached `uv tool list` snapshot. Note: `uvx <pkg>` runs
 * one-shot (cached but not "installed") whereas `uv tool install <pkg>`
 * is the persistent form. We require persistent installation — same
 * mental model as npx-global vs npx-on-demand.
 */
function isUvxPackageInstalled(entry: KnownAgentEntry): boolean {
  const pkgSpec = entry.spec.args?.[0];
  if (!pkgSpec) return false;
  // uvx packages may use `==<version>` (PEP 440) or `@<version>`
  // (registry's normalized form). Strip whichever appears.
  let pkgName = pkgSpec;
  for (const sep of ["==", "@"]) {
    const idx = pkgName.indexOf(sep, 1);
    if (idx > 0) { pkgName = pkgName.slice(0, idx); break; }
  }
  const cache = _uvToolCache ?? (_uvToolCache = snapshotUvTool());
  return cache.has(pkgName);
}

/**
 * Snapshot of globally installed npm packages, by name (no version).
 * One subprocess per daemon startup; ~80ms on a typical macOS box.
 *
 * `npm ls -g --depth=0 --parseable` prints one line per top-level
 * package as a `<prefix>/lib/node_modules/<name>` path; we parse the
 * basename. Robust to JSON output flakiness on Windows / weird npm
 * configs.
 */
function snapshotNpmGlobal(): Set<string> {
  try {
    const r = spawnSync("npm", ["ls", "-g", "--depth=0", "--parseable"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (r.status !== 0 && !r.stdout) return new Set();
    const out = new Set<string>();
    for (const line of (r.stdout ?? "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.lastIndexOf("/node_modules/");
      if (idx < 0) continue;
      const tail = trimmed.slice(idx + "/node_modules/".length);
      if (!tail) continue;
      out.add(tail);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Snapshot of `uv tool`-installed Python packages. Lines look like
 *   `package-name v0.7.0`
 *      `- entrypoint`
 * (entrypoint lines are indented). We only care about top-level lines.
 * Returns empty set if uv isn't installed at all.
 */
function snapshotUvTool(): Set<string> {
  try {
    const r = spawnSync("uv", ["tool", "list"], { encoding: "utf-8", timeout: 10_000 });
    if (r.status !== 0 && !r.stdout) return new Set();
    const out = new Set<string>();
    for (const line of (r.stdout ?? "").split("\n")) {
      // Top-level lines start with a non-whitespace char and have a
      // version after the package name. Skip indented (`- `) entries
      // and warning lines (start with "warning:").
      if (!line || line.startsWith(" ") || line.startsWith("warning:")) continue;
      const m = line.match(/^([a-zA-Z0-9._-]+)\s+v?\d/);
      if (m) out.add(m[1]);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Run `which` (or `where` on Windows). Resolves to true iff exit code 0. */
function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const p = spawn(probe, [cmd], { stdio: "ignore" });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
}

/** Detect every known agent (merged registry). Useful for "list available agents" UI. */
export async function detectAll(): Promise<KnownAgentEntry[]> {
  const list = getKnownAgents();
  const results = await Promise.all(list.map((e) => detect(e.id)));
  return results.filter((e): e is KnownAgentEntry => e !== null);
}
