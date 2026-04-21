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
  insert(row: NewInstallation): Promise<Installation>;
  /** Set the vault id holding the bearer credential for this install. */
  setVaultId(id: string, vaultId: string): Promise<void>;
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
