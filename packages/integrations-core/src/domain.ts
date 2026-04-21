// Domain value types for integrations.
//
// These are the shapes passed across package boundaries. Concrete adapters
// (D1, GraphQL clients) translate to and from these types.

export type ProviderId = "linear"; // narrow now; widen as providers are added

/** Linear workspace id (or equivalent in future providers). */
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
 * Capability keys gating Linear API operations. Stable strings, used in JWT
 * scopes and DB rows.
 */
export type CapabilityKey =
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
  | "search.read";

export type CapabilitySet = ReadonlySet<CapabilityKey>;

export type InstallKind = "dedicated";

export type PublicationMode = "full";

export type PublicationStatus =
  | "pending_setup"
  | "awaiting_install"
  | "live"
  | "needs_reauth"
  | "unpublished";

export type IssueSessionStatus =
  | "active"
  | "completed"
  | "human_handoff"
  | "rerouted"
  | "escalated";

export type SessionGranularity = "per_issue" | "per_event";

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

export interface IssueSession {
  publicationId: string;
  /** Provider-native issue id. */
  issueId: string;
  sessionId: SessionId;
  status: IssueSessionStatus;
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
