/**
 * Official ACP Registry — fetch, cache, and map to our internal shape.
 *
 * Source of truth: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 * Maintained by the ACP project (Apache 2.0). 35+ agents as of May 2026,
 * auto-updated hourly by their CI when upstream agents publish new versions.
 *
 * We deliberately do NOT hand-maintain a parallel agent list — by the time
 * we ship the next OMA release, half the entries would be stale on
 * versions or missing entirely. Instead:
 *
 *   1. Daemon startup: try to fetch the official JSON. Cache verbatim to
 *      <bridge configDir>/registry-cache.json with `fetchedAt`.
 *   2. Subsequent loads: serve from cache while it's fresh (1h matches
 *      their cron, anything newer would be the same JSON anyway).
 *   3. Network failure: keep using stale cache forever. A daemon that
 *      can't reach the CDN should still spawn agents the user has
 *      already paired.
 *   4. Cold start with no cache and no network: fall back to OMA's
 *      static overlay (see known-agents.ts) — at least the well-known
 *      agents we hand-maintain still work.
 *
 * Browser bundles (Console) shouldn't import this — they only need the
 * overlay metadata to render install hints. Importing fetch / fs would
 * pull node-only modules into the Vite build.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSpec } from "./types.js";
import type { KnownAgentEntry } from "./known-agents.js";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h, matches their CI cron

/** Subset of the official schema we actually consume. Extra fields (icon,
 *  authors, etc.) pass through unread. Future-proofs us against schema
 *  growth — adding a new distribution kind we don't recognize gracefully
 *  degrades to "agent not spawnable on this host" instead of crashing. */
export interface OfficialRegistryAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  license?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<string, { archive: string; cmd: string; args?: string[] }>;
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
  };
}

interface OfficialRegistry {
  version: number;
  agents: OfficialRegistryAgent[];
  extensions?: unknown[];
}

interface CachedRegistry {
  fetchedAt: number;
  data: OfficialRegistry;
}

/**
 * Fetch the official registry, caching to disk. Returns the parsed JSON.
 * Network errors fall through to stale cache; if no cache exists, throws
 * so caller can decide how to degrade (typically: fall back to overlay-
 * only, see registry.ts:loadRegistry).
 */
export async function fetchOfficialRegistry(opts?: {
  cachePath?: string;
  ttlMs?: number;
  /** Skip network and serve cache only — used by tests. */
  cacheOnly?: boolean;
}): Promise<OfficialRegistry> {
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cachePath = opts?.cachePath;

  // Try cache first if it's still fresh — saves a network round-trip on
  // every daemon start when nothing has changed upstream.
  if (cachePath) {
    const cached = await readCache(cachePath);
    if (cached && Date.now() - cached.fetchedAt < ttl) {
      return cached.data;
    }
    if (cached && opts?.cacheOnly) return cached.data;
  }

  if (opts?.cacheOnly) {
    throw new Error("registry cacheOnly=true but no cache exists");
  }

  // Network. Short timeout so a hung CDN doesn't stall daemon startup
  // — 5s is plenty for a JSON fetch on the global CDN; if it's slower
  // than that we'd rather fall back to cache/overlay than wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`registry fetch HTTP ${res.status}`);
    const data = (await res.json()) as OfficialRegistry;
    if (!Array.isArray(data?.agents)) {
      throw new Error("registry JSON malformed (no .agents array)");
    }
    if (cachePath) {
      // Best-effort cache write — disk full / permission errors must
      // not break the registry call itself.
      await writeCache(cachePath, { fetchedAt: Date.now(), data }).catch(() => {});
    }
    return data;
  } catch (e) {
    // Network failed — last-ditch: serve stale cache if any.
    if (cachePath) {
      const stale = await readCache(cachePath);
      if (stale) return stale.data;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(path: string): Promise<CachedRegistry | null> {
  try {
    const text = await readFile(path, "utf-8");
    const obj = JSON.parse(text) as CachedRegistry;
    if (typeof obj?.fetchedAt !== "number" || !Array.isArray(obj?.data?.agents)) return null;
    return obj;
  } catch { return null; }
}

async function writeCache(path: string, c: CachedRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(c, null, 2), "utf-8");
}

/**
 * Translate an official-registry agent entry into our internal
 * KnownAgentEntry shape. Returns null when no distribution applies to
 * this host (e.g. binary-only entry with no archive for current
 * platform; or all distributions are types we don't know how to spawn).
 *
 * Distribution preference: native binary first (no `npx` cold-start
 * cost on every spawn), then npx, then uvx. The chosen distribution
 * dictates spec.command. installHint always carries the "official" way
 * to install for the user's reference.
 */
export function mapOfficialAgent(o: OfficialRegistryAgent): KnownAgentEntry | null {
  const platformKey = `${process.platform === "win32" ? "windows" : process.platform}-${
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  }`;

  let spec: AgentSpec | null = null;
  let installHint: string | undefined;
  let install: KnownAgentEntry["install"] | undefined;

  if (o.distribution.binary?.[platformKey]) {
    const b = o.distribution.binary[platformKey];
    // Strip leading "./" — `cmd` is relative to the extracted archive
    // root, but once installed on PATH it's just the bare binary name.
    const command = b.cmd.replace(/^\.\//, "").replace(/\.exe$/, "");
    spec = { command, args: b.args };
    installHint = `download ${b.archive} and place \`${command}\` on PATH`;
    // Carry every platform the registry knows about into install.archives
    // — even though only the current host's entry will be used by the
    // downloader, the merged registry travels through other code paths
    // (Console rendering, refresh on a different host's daemon via
    // SIGHUP after a registry update). Cheap data; future-proof.
    const archives: Record<string, { url: string; cmd: string }> = {};
    for (const [k, v] of Object.entries(o.distribution.binary)) {
      archives[k] = { url: v.archive, cmd: v.cmd };
    }
    install = { kind: "binary", archives, downloadUrl: o.repository };
  } else if (o.distribution.npx) {
    const n = o.distribution.npx;
    // Use `npx -y` to skip the install confirmation prompt; pin to the
    // exact package@version from registry for reproducibility.
    spec = { command: "npx", args: ["-y", n.package, ...(n.args ?? [])], env: n.env };
    installHint = `npx -y ${n.package}` + (n.args ? " " + n.args.join(" ") : "");
    // For npm install, drop the @version suffix so we get latest. The
    // detect snapshot only matches by package name anyway, so a bumped
    // upstream still resolves cleanly without us having to chase
    // versions in the overlay.
    const lastAt = n.package.lastIndexOf("@");
    const pkgName = lastAt > 0 ? n.package.slice(0, lastAt) : n.package;
    install = { kind: "npm", package: pkgName };
  } else if (o.distribution.uvx) {
    const u = o.distribution.uvx;
    spec = { command: "uvx", args: [u.package, ...(u.args ?? [])], env: u.env };
    installHint = `uvx ${u.package}` + (u.args ? " " + u.args.join(" ") : "");
    // No `install` for uvx yet — adding `uv tool install` support is a
    // separate kind we'll wire up alongside other Python-tool kinds.
  }

  if (!spec) return null;

  return {
    id: o.id,
    label: o.name,
    spec,
    installHint,
    install,
    homepage: o.website ?? o.repository,
  };
}
