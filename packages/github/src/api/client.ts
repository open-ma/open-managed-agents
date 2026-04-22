// Minimal GitHub REST client for the small set of operations the integration
// needs server-side. Hand-rolled — no codegen since the surface is tiny.
//
// Two auth modes:
//   - App JWT (Bearer mintAppJwt() output): for `/app/*` endpoints.
//   - Installation token (Bearer ghs_…): for repo / org / issue endpoints.
//
// MCP tool calls are NOT routed through here — the agent talks to the GitHub
// MCP server directly with the installation token from its vault.

import type { HttpClient } from "@open-managed-agents/integrations-core";

const GITHUB_API = "https://api.github.com";

export interface AppInfo {
  /** Numeric App ID (also `iss` claim in the App JWT). */
  id: number;
  /** Human name shown on github.com/apps/<slug>. */
  name: string;
  /** URL slug — what we put in the install URL. */
  slug: string;
  /** Bot user login that the App acts as on writes (e.g. "myapp[bot]"). */
  botLogin: string;
  /** Numeric user id of the bot user. */
  botUserId: number;
  /** Optional avatar (githubusercontent.com URL). */
  avatarUrl: string | null;
  htmlUrl: string;
}

export interface InstallationAccount {
  id: number;
  /** Org or user name e.g. "acme". */
  login: string;
  type: "User" | "Organization";
  avatarUrl: string | null;
}

export interface InstallationDetail {
  id: number;
  account: InstallationAccount;
  repositorySelection: "all" | "selected";
  appId: number;
  permissions: Record<string, string>;
  events: ReadonlyArray<string>;
  htmlUrl: string;
}

export class GitHubApiClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * `GET /app` — returns the App's slug + bot user info. Auth: App JWT.
   * Used during install to derive the install URL and the bot's login (which
   * the webhook parser needs to detect "@mention" / "assigned-to-bot").
   */
  async getApp(appJwt: string): Promise<AppInfo> {
    const res = await this.http.fetch({
      method: "GET",
      url: `${GITHUB_API}/app`,
      headers: this.appHeaders(appJwt),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new GitHubApiError(`GET /app: HTTP ${res.status} ${res.body.slice(0, 200)}`, res.status);
    }
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const id = parsed.id;
    const slug = parsed.slug;
    const name = parsed.name;
    if (typeof id !== "number" || typeof slug !== "string" || typeof name !== "string") {
      throw new GitHubApiError(`GET /app: missing id/slug/name in response: ${res.body.slice(0, 200)}`, res.status);
    }
    return {
      id,
      slug,
      name,
      botLogin: `${slug}[bot]`,
      // GitHub API doesn't return the bot user id directly here. We can resolve
      // it from `GET /users/<slug>[bot]` if we need a stable numeric id; for
      // now login is enough for routing.
      botUserId: 0,
      avatarUrl: null,
      htmlUrl: `https://github.com/apps/${slug}`,
    };
  }

  /**
   * `GET /app/installations/:id` — full install detail (account, perms, repo
   * selection). Auth: App JWT.
   */
  async getInstallation(appJwt: string, installationId: string): Promise<InstallationDetail> {
    const res = await this.http.fetch({
      method: "GET",
      url: `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`,
      headers: this.appHeaders(appJwt),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new GitHubApiError(
        `GET /app/installations/${installationId}: HTTP ${res.status} ${res.body.slice(0, 200)}`,
        res.status,
      );
    }
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const id = parsed.id as number;
    const account = parsed.account as { id: number; login: string; type: string; avatar_url?: string };
    if (typeof id !== "number" || !account || typeof account.login !== "string") {
      throw new GitHubApiError(
        `GET /app/installations/${installationId}: malformed response`,
        res.status,
      );
    }
    return {
      id,
      account: {
        id: account.id,
        login: account.login,
        type: account.type === "Organization" ? "Organization" : "User",
        avatarUrl: account.avatar_url ?? null,
      },
      repositorySelection: (parsed.repository_selection as "all" | "selected") ?? "selected",
      appId: (parsed.app_id as number) ?? 0,
      permissions: (parsed.permissions as Record<string, string>) ?? {},
      events: (parsed.events as string[]) ?? [],
      htmlUrl: (parsed.html_url as string) ?? "",
    };
  }

  /**
   * `GET /users/{login}` — used to resolve the bot user's numeric id from its
   * login `<slug>[bot]`. Optional helper; not required for v1.
   */
  async getUserByLogin(installationToken: string, login: string): Promise<{ id: number; avatar_url: string | null } | null> {
    const res = await this.http.fetch({
      method: "GET",
      url: `${GITHUB_API}/users/${encodeURIComponent(login)}`,
      headers: this.installationHeaders(installationToken),
    });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) {
      throw new GitHubApiError(
        `GET /users/${login}: HTTP ${res.status} ${res.body.slice(0, 200)}`,
        res.status,
      );
    }
    const p = JSON.parse(res.body) as { id?: number; avatar_url?: string };
    if (typeof p.id !== "number") return null;
    return { id: p.id, avatar_url: p.avatar_url ?? null };
  }

  private appHeaders(appJwt: string): Record<string, string> {
    return {
      authorization: `Bearer ${appJwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-managed-agents",
    };
  }

  private installationHeaders(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-managed-agents",
    };
  }
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}
