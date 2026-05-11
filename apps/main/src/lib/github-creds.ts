/**
 * GitHub credential routing for the network-layer outbound proxy.
 *
 * Sandbox containers fire plain HTTPS at github.com / api.github.com with
 * no Authorization header. The agent worker's outbound interceptor calls
 * `resolveGithubCredentials` to get an ordered candidate list of tokens
 * to try (per-session, picked from the session's github_repository
 * resources), then injects Authorization upstream and retries on 401.
 *
 * Scope (intentional, see γ trim decision):
 *   - github.com (smart-HTTP git protocol) → Basic auth
 *   - api.github.com (REST + GraphQL)      → Bearer
 *   - everything else (uploads, lfs, codeload, raw, githubusercontent
 *     CDN) is left to the catch-all credential resolver — public content
 *     works as passthrough; private uncommon-host calls 401, accepted.
 *
 * Multi-repo routing strategy (intentionally simple):
 *   - parse (owner, repo) from the request URL → if it matches a
 *     github_repository resource, return that resource's token
 *   - if it doesn't match (or path has no owner/repo, e.g. /graphql,
 *     /user, /search), return the first github_repository resource's
 *     token
 *   - if the session has no github_repository resources at all, return
 *     null (caller passes through unauthenticated)
 *
 * Known limitation: when a session attaches multiple repos with tokens
 * that don't share scope (e.g. two PATs for two distinct orgs), non-repo-
 * scoped calls (/graphql etc.) always use the first resource's token.
 * The other token is simply unreachable for those calls. UI surfaces a
 * hint about this.
 *
 * String-match safety: parseRepoSlug normalizes case, collapses path
 * traversal (`..` / `//`), strips `.git`, validates against the GH login
 * charset. Defenses are described inline.
 */

import type { Services } from "@open-managed-agents/services";

/** Hosts whose outbound traffic the agent worker rewrites with a per-repo
 *  GitHub token. Lowercase. Anything not in this set is left alone. */
export const GITHUB_HOSTS = ["github.com", "api.github.com"] as const;
export type GitHubHost = typeof GITHUB_HOSTS[number];

export function isGithubHost(hostname: string): hostname is GitHubHost {
  return (GITHUB_HOSTS as readonly string[]).includes(hostname.toLowerCase());
}

/** Auth scheme by host. github.com smart-HTTP is documented for Basic
 *  with `x-access-token:<token>`; Bearer is undocumented for that endpoint
 *  so we play safe. api.github.com officially accepts Bearer for both
 *  PATs and installation tokens. */
export function authSchemeFor(hostname: string): "Basic" | "Bearer" {
  return hostname.toLowerCase() === "github.com" ? "Basic" : "Bearer";
}

// GitHub login/repo charset. Login is strict ASCII alnum + dashes
// (no leading/trailing dash); repo names additionally allow `.` and `_`.
const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]+$/;

/** Normalize anything that looks like a GitHub repo reference to the
 *  canonical lowercase `"owner/repo"` slug, or null if it isn't one.
 *
 *  Accepts:
 *    - `https://github.com/Owner/Repo(.git)?[/anything]`
 *    - `https://api.github.com/repos/Owner/Repo[/anything]`
 *    - `git@github.com:Owner/Repo(.git)?`
 *    - bare `Owner/Repo(.git)?`
 *
 *  Defenses:
 *    - lowercases owner+repo (GitHub login is case-insensitive)
 *    - collapses `..` and empty segments in path
 *    - strips `.git` suffix
 *    - rejects anything outside the GH login charset (no Unicode homoglyph)
 */
export function parseRepoSlug(input: string): string | null {
  if (!input) return null;
  let owner: string | undefined;
  let repo: string | undefined;

  // URL form (full or API).
  if (input.startsWith("http://") || input.startsWith("https://")) {
    let u: URL;
    try { u = new URL(input); } catch { return null; }
    const host = u.hostname.toLowerCase();
    // Path-segment normalize: drop empties + `.`, collapse `..`.
    const parts: string[] = [];
    for (const seg of u.pathname.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") { parts.pop(); continue; }
      parts.push(seg);
    }
    if (host === "github.com" || host === "www.github.com") {
      owner = parts[0];
      repo = parts[1];
    } else if (host === "api.github.com" && parts[0] === "repos") {
      owner = parts[1];
      repo = parts[2];
    }
  }

  // SSH form: git@github.com:owner/repo(.git)?
  if (!owner) {
    const ssh = input.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (ssh) { owner = ssh[1]; repo = ssh[2]; }
  }

  // Bare: owner/repo(.git)? — only if no slashes beyond the one
  if (!owner) {
    const bare = input.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (bare) { owner = bare[1]; repo = bare[2]; }
  }

  if (!owner || !repo) return null;
  repo = repo.replace(/\.git$/i, "");
  if (!GH_LOGIN_RE.test(owner) || !GH_REPO_RE.test(repo)) return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

export interface GithubCandidate {
  scheme: "Basic" | "Bearer";
  token: string;
  /** owner/repo of the source resource — for logging / debug only. */
  slug: string;
}

/**
 * Pick a GitHub token for an outbound call.
 *
 * Returns null in three cases (caller behavior identical: passthrough
 * unauthenticated):
 *   - host isn't a GitHub host we route
 *   - session not found / archived
 *   - session has no usable github_repository resources
 *
 * Otherwise: path-matched resource's token if the request URL slug
 * matches one; first declared resource's token otherwise.
 */
export async function resolveGithubCredentials(
  services: Services,
  tenantId: string,
  sid: string,
  hostname: string,
  pathname: string,
): Promise<GithubCandidate | null> {
  if (!isGithubHost(hostname)) return null;

  const session = await services.sessions
    .get({ tenantId, sessionId: sid })
    .catch(() => null);
  if (!session) return null;
  if ((session as { archived_at?: string | null }).archived_at) return null;

  const rows = await services.sessions
    .listResourcesBySession({ sessionId: sid })
    .catch(() => []);

  const requestSlug = parseRepoSlug(`https://${hostname}${pathname}`);
  const scheme = authSchemeFor(hostname);

  let fallback: GithubCandidate | null = null;
  for (const row of rows) {
    const r = row.resource as { type?: string; url?: string } | undefined;
    if (r?.type !== "github_repository" || !r.url) continue;
    const resSlug = parseRepoSlug(r.url);
    if (!resSlug) continue;
    const token = await services.sessionSecrets
      .get({ tenantId, sessionId: sid, resourceId: row.id })
      .catch(() => undefined);
    if (!token) continue;
    const cand: GithubCandidate = { scheme, token, slug: resSlug };
    if (resSlug === requestSlug) return cand;
    if (!fallback) fallback = cand;   // first usable resource
  }
  return fallback;
}
