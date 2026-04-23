// Domain value types for integrations.
//
// These are the shapes passed across package boundaries. Concrete adapters
// (D1, GraphQL clients) translate to and from these types.

export type ProviderId = "linear" | "github" | "slack";

/** External workspace id (Linear workspace, Slack team, etc.). */
export type WorkspaceId = string;

/** OMA platform user (better-auth user id). */
export type UserId = string;

/** OMA agent id. */
export type AgentId = string;

/** OMA session id. */
export type SessionId = string;

export interface Persona {
  /** Display name shown in the integration's UI (e.g. createAsUser, App name). */
  name: string;
  /** Avatar URL shown alongside the name. */
  avatarUrl: string | null;
}

/**
/**
 * Capability keys gating provider API operations. Stable strings, used in JWT
 * scopes and DB rows. Cross-provider keys (`issue.*` / `comment.*` / etc.)
 * are shared so a publication can hold a uniform capability shape regardless
 * of source — providers ignore keys that don't apply to them. Provider-
 * specific keys (GitHub's `pr.*`, Slack's `message.*`) coexist in the union;
 * each provider narrows internally.
 */
export type CapabilityKey =
  // Cross-provider
  | "issue.read"
  | "issue.create"
  | "issue.update"
  | "issue.delete"
  | "comment.write"
  | "comment.delete"
  | "label.add"
  | "label.remove"
  | "assignee.set"
  | "assignee.set_other"
  | "status.set"
  | "priority.set"
  | "subissue.create"
  | "user.mention"
  | "search.read"
  // GitHub-specific
  | "pr.read"
  | "pr.create"
  | "pr.update"
  | "pr.merge"
  | "pr.close"
  | "pr.review.write"
  | "pr.review.comment"
  | "repo.read"
  | "repo.write"
  | "repo.branch.create"
  | "repo.branch.delete"
  | "workflow.read"
  | "workflow.dispatch"
  | "release.read"
  | "release.create"
  // Slack-specific
  | "message.read"
  | "message.write"
  | "message.update"
  | "message.delete"
  | "thread.reply"
  | "reaction.add"
  | "reaction.remove"
  | "user.read"
  | "canvas.write";

export type CapabilitySet = ReadonlySet<CapabilityKey>;

export type InstallKind = "dedicated";

export type PublicationMode = "full";

export type PublicationStatus =
  | "pending_setup"
  | "awaiting_install"
  | "live"
  | "needs_reauth"
  | "unpublished";

export type SessionScopeStatus =
  | "active"
  | "completed"
  | "human_handoff"
  | "rerouted"
  | "escalated";

export type SessionGranularity = "per_issue" | "per_thread" | "per_event";

export interface Installation {
  id: string;
  userId: UserId;
  providerId: ProviderId;
  workspaceId: WorkspaceId;
  workspaceName: string;
  installKind: InstallKind;
  /** Set only when installKind === "dedicated"; references AppRepo. */
  appId: string | null;
  /** Bot user id assigned by the provider when the install completed. */
  botUserId: string;
  scopes: ReadonlyArray<string>;
  /**
   * Vault id (in OMA's tenant) holding the bearer credential for this
   * install's external API. Sessions triggered by this install bind to this
   * vault so the outbound Worker can inject the token.
   */
  vaultId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface Publication {
  id: string;
  userId: UserId;
  agentId: AgentId;
  installationId: string;
  /**
   * OMA environment the agent runs in when triggered by this publication.
   * Bound at publish time; required for the gateway to spin up a sandbox.
   */
  environmentId: string;
  mode: PublicationMode;
  status: PublicationStatus;
  persona: Persona;
  capabilities: CapabilitySet;
  sessionGranularity: SessionGranularity;
  createdAt: number;
  unpublishedAt: number | null;
}

export interface AppCredentials {
  id: string;
  /** Set only after the related publication has been materialized. */
  publicationId: string | null;
  /** OAuth client id from the provider's developer portal. */
  clientId: string;
  /** Stored encrypted; adapters return plaintext via Crypto.decrypt. */
  clientSecretCipher: string;
  /** Stored encrypted; HMAC secret for incoming webhooks. */
  webhookSecretCipher: string;
  createdAt: number;
}

/**
 * GitHub App credentials. Distinct from `AppCredentials` because GitHub Apps
 * carry a few extra invariants Linear's OAuth apps don't have:
 *
 *   - Numeric `appId` (used as `iss` in App JWTs)
 *   - URL `appSlug` (used to build the install link)
 *   - `botLogin` (e.g. "myapp[bot]" — needed at webhook parse time to
 *     detect "@mention" / "assigned-to-bot")
 *   - PEM-encoded RSA private key (used to mint short-lived App JWTs which
 *     in turn mint per-installation access tokens)
 *
 * `clientId` / `clientSecret` are optional — only needed if the App also
 * supports OAuth-style "Sign in with GitHub" for user attribution. For the
 * pure App-bot install used by OMA today, both are null.
 */
export interface GitHubAppCredentials {
  id: string;
  publicationId: string | null;
  appId: string;
  appSlug: string;
  botLogin: string;
  clientId: string | null;
  clientSecretCipher: string | null;
  webhookSecretCipher: string;
  privateKeyCipher: string;
  createdAt: number;
}

/**
 * Per-issue session reuse for Linear/GitHub providers. Linear binds one
 * session per issue UUID; GitHub binds one per `<repo>#<number>`. Slack uses
 * a parallel `SessionScope` keyed on `${channel}:${thread_ts}` (see below).
 */
export interface IssueSession {
  publicationId: string;
  /** Provider-native issue id. */
  issueId: string;
  sessionId: SessionId;
  status: IssueSessionStatus;
  createdAt: number;
}

export type IssueSessionStatus = SessionScopeStatus;

/**
 * Generalized session-scope binding for providers whose session granularity
 * isn't a single issue id. Slack uses this with `scopeKey = ${channel_id}:
 * ${thread_ts ?? event_ts}`. Same shape as `IssueSession`, just with an
 * opaque `scopeKey` instead of a provider-native `issueId`.
 */
export interface SessionScope {
  publicationId: string;
  /**
   * Provider-native key identifying the conversational scope this session is
   * bound to. Linear stores the issue id (e.g. `iss_…`); Slack stores
   * `${channel_id}:${thread_ts ?? event_ts}`. Opaque to core.
   */
  scopeKey: string;
  sessionId: SessionId;
  status: SessionScopeStatus;
  createdAt: number;
}

export interface SetupLink {
  token: string;
  publicationId: string;
  createdBy: UserId;
  expiresAt: number;
  usedAt: number | null;
  usedByEmail: string | null;
}
