// Repository ports — persistence boundary.
//
// Providers and route handlers depend on these interfaces, never on D1 or any
// concrete query builder. Adapters in integrations-adapters-cf implement them
// against D1.
//
// Mutations return the resulting row when useful; reads return null on miss
// rather than throwing. Errors mean infrastructure failure, not "not found".

import type {
  AppCredentials,
  CapabilitySet,
  GitHubAppCredentials,
  Installation,
  IssueSession,
  IssueSessionStatus,
  Persona,
  Publication,
  PublicationStatus,
  ProviderId,
  SessionGranularity,
  SetupLink,
  UserId,
  WorkspaceId,
  InstallKind,
  PublicationMode,
  AgentId,
} from "./domain";

export interface NewInstallation {
  userId: UserId;
  providerId: ProviderId;
  workspaceId: WorkspaceId;
  workspaceName: string;
  installKind: InstallKind;
  appId: string | null;
  botUserId: string;
  /** Will be encrypted before storage. */
  accessToken: string;
  refreshToken: string | null;
  scopes: ReadonlyArray<string>;
}

export interface InstallationRepo {
  get(id: string): Promise<Installation | null>;
  findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null>;
  listByUser(userId: UserId, providerId: ProviderId): Promise<ReadonlyArray<Installation>>;
  /**
   * Returns the decrypted access token for a live installation, or null if
   * revoked. Implementations are expected to hold a Crypto instance.
   */
  getAccessToken(id: string): Promise<string | null>;
  /**
   * Returns the decrypted refresh token (if one was persisted), or null. Used
   * by the provider to renew an expired access token without forcing the user
   * to reinstall the OAuth app.
   */
  getRefreshToken(id: string): Promise<string | null>;
  insert(row: NewInstallation): Promise<Installation>;
  /** Set the vault id holding the bearer credential for this install. */
  setVaultId(id: string, vaultId: string): Promise<void>;
  /**
   * Atomically rotate the stored access token (and refresh token, which the
   * provider may rotate alongside). Both values are encrypted before storage.
   * Pass refreshToken=null to leave the existing refresh row untouched only
   * when the upstream response did not return one.
   */
  setTokens(id: string, accessToken: string, refreshToken: string | null): Promise<void>;
  markRevoked(id: string, at: number): Promise<void>;
}

export interface NewPublication {
  userId: UserId;
  agentId: AgentId;
  installationId: string;
  environmentId: string;
  mode: PublicationMode;
  status: PublicationStatus;
  persona: Persona;
  capabilities: CapabilitySet;
  sessionGranularity: SessionGranularity;
}

export interface PublicationRepo {
  get(id: string): Promise<Publication | null>;
  listByInstallation(installationId: string): Promise<ReadonlyArray<Publication>>;
  listByUserAndAgent(
    userId: UserId,
    agentId: AgentId,
  ): Promise<ReadonlyArray<Publication>>;
  insert(row: NewPublication): Promise<Publication>;
  updateStatus(id: string, status: PublicationStatus): Promise<void>;
  updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void>;
  updatePersona(id: string, persona: Persona): Promise<void>;
  markUnpublished(id: string, at: number): Promise<void>;
}

export interface NewAppCredentials {
  /**
   * Optional explicit id. When provided, insert behaves as an upsert keyed on
   * id (re-submitting the same App row with the same id updates the
   * credentials in place). When omitted, the repo generates a fresh id.
   */
  id?: string;
  /** Null when registered ahead of the related publication (A1 install). */
  publicationId: string | null;
  clientId: string;
  /** Will be encrypted before storage. */
  clientSecret: string;
  /** Will be encrypted before storage. */
  webhookSecret: string;
}

export interface AppRepo {
  get(id: string): Promise<AppCredentials | null>;
  getByPublication(publicationId: string): Promise<AppCredentials | null>;
  /** Returns the decrypted webhook secret for HMAC verification. */
  getWebhookSecret(id: string): Promise<string | null>;
  /** Returns the decrypted client secret for OAuth token exchange. */
  getClientSecret(id: string): Promise<string | null>;
  insert(row: NewAppCredentials): Promise<AppCredentials>;
  /** Set publication_id after the related publication is materialized. */
  setPublicationId(id: string, publicationId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface NewGitHubAppCredentials {
  /** Optional explicit id; insert behaves as upsert when provided. */
  id?: string;
  publicationId: string | null;
  /** Numeric GitHub App id (string-typed so we don't truncate large ints). */
  appId: string;
  appSlug: string;
  botLogin: string;
  clientId: string | null;
  /** Will be encrypted before storage. Pass null when not using OAuth. */
  clientSecret: string | null;
  /** Will be encrypted before storage. */
  webhookSecret: string;
  /** Will be encrypted before storage. PEM-encoded RSA private key. */
  privateKey: string;
}

export interface GitHubAppRepo {
  get(id: string): Promise<GitHubAppCredentials | null>;
  getByPublication(publicationId: string): Promise<GitHubAppCredentials | null>;
  /** Match by GitHub's numeric app_id (e.g. on webhook dispatch). */
  getByAppId(appId: string): Promise<GitHubAppCredentials | null>;
  getWebhookSecret(id: string): Promise<string | null>;
  getClientSecret(id: string): Promise<string | null>;
  /** Returns the decrypted PEM private key for App JWT minting. */
  getPrivateKey(id: string): Promise<string | null>;
  insert(row: NewGitHubAppCredentials): Promise<GitHubAppCredentials>;
  setPublicationId(id: string, publicationId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookEventStore {
  /**
   * Atomically inserts the delivery id; returns true if it's new (caller should
   * proceed to dispatch), false if it's a duplicate (caller should return 200
   * immediately).
   */
  recordIfNew(
    deliveryId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean>;
  attachSession(deliveryId: string, sessionId: string): Promise<void>;
  attachPublication(deliveryId: string, publicationId: string): Promise<void>;
  attachError(deliveryId: string, error: string): Promise<void>;
}

export interface IssueSessionRepo {
  getByIssue(publicationId: string, issueId: string): Promise<IssueSession | null>;
  insert(row: IssueSession): Promise<void>;
  updateStatus(
    publicationId: string,
    issueId: string,
    status: IssueSessionStatus,
  ): Promise<void>;
  listActive(publicationId: string): Promise<ReadonlyArray<IssueSession>>;
}

/**
 * Tracks comments the bot authored via the OMA-hosted Linear MCP server's
 * `linear_post_comment` tool. Lets us route a Linear `Comment` webhook with
 * a `parentId` back to the bot's OMA session.
 *
 * Slim schema by design: anything derivable from the omaSessionId
 * (publication / installation / vault) is fetched on demand at webhook
 * time. Only `issueId` is kept inline — it's used by the bot's
 * thread-context tools without needing a session record round-trip.
 */
export interface AuthoredComment {
  commentId: string;
  omaSessionId: string;
  issueId: string;
  createdAt: number;
}

export interface AuthoredCommentRepo {
  get(commentId: string): Promise<AuthoredComment | null>;
  insert(row: AuthoredComment): Promise<void>;
}

/**
 * Per-OMA-session pointer to the Linear AgentSession panel the bot is
 * currently "in". The bot writes this via the linear_enter_panel /
 * linear_exit_panel MCP tools; the event-tap reads it to decide whether
 * (and where) to mirror agent broadcasts as Linear AgentActivity entries.
 *
 * One row per OMA session; absence = bot is off-panel (silent / posting
 * comments via the comment tools instead).
 */
export interface PanelBinding {
  omaSessionId: string;
  panelAgentSessionId: string;
  updatedAt: number;
  /** Stamped by the linear_request_input MCP tool right after the elicitation
   *  activity is posted. event-tap reads it to drop ALL trailing broadcasts
   *  for the same turn, so Linear sees only the elicitation and keeps the
   *  panel in `awaitingInput` (with the inline reply box). Null means no
   *  elicitation was made yet on this binding. */
  lastElicitationAt: number | null;
}

export interface PanelBindingRepo {
  get(omaSessionId: string): Promise<PanelBinding | null>;
  set(omaSessionId: string, panelAgentSessionId: string, updatedAt: number): Promise<void>;
  /** Stamp the elicitation timestamp on the existing binding row. No-op if
   *  the row doesn't exist (which would mean the bot called
   *  linear_request_input without entering a panel — handler validates that
   *  upstream). */
  stampElicitation(omaSessionId: string, ts: number): Promise<void>;
  clear(omaSessionId: string): Promise<void>;
}

export interface NewSetupLink {
  publicationId: string;
  createdBy: UserId;
  expiresAt: number;
}

export interface SetupLinkRepo {
  get(token: string): Promise<SetupLink | null>;
  insert(row: NewSetupLink): Promise<SetupLink>;
  markUsed(token: string, usedByEmail: string, usedAt: number): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}
