// Runtime ports — abstract dependencies a provider needs from its host.
//
// Provider packages (e.g. @open-managed-agents/linear) accept implementations
// of these via constructor injection. Adapter packages (e.g.
// @open-managed-agents/integrations-adapters-cf) implement them against
// concrete runtimes.
//
// Keep these tiny and runtime-agnostic. Do not import Web Request/Response
// types here — pass plain data instead.

import type { SessionId, AgentId, UserId } from "./domain";
import type {
  AppRepo,
  InstallationRepo,
  IssueSessionRepo,
  PublicationRepo,
  SetupLinkRepo,
  WebhookEventStore,
} from "./persistence";

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
}

export interface IdGenerator {
  /** URL-safe random id, ≥128 bits of entropy. */
  generate(): string;
}

/**
 * Symmetric encryption for tokens at rest. Output is opaque to callers — only
 * the same Crypto instance can decrypt what it produced.
 */
export interface Crypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

/**
 * Constant-time HMAC verification for webhook signatures. Separate from Crypto
 * so adapters can use Web Crypto's verify() directly.
 */
export interface HmacVerifier {
  verify(secret: string, body: string, signature: string): Promise<boolean>;
}

/**
 * Short-lived signed tokens scoped to a single MCP session. The payload type
 * is opaque here; provider code defines and validates its own shape.
 */
export interface JwtSigner {
  sign(payload: object, ttlSeconds: number): Promise<string>;
  verify<T extends object = object>(token: string): Promise<T>;
}

/**
 * Plain HTTP client. Avoids depending on Web Fetch types so this package can
 * be unit-tested in pure Node without polyfills.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HttpClient {
  fetch(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * Bridge to OMA's session lifecycle. Implemented as a service-binding call to
 * apps/main in production; an in-memory fake in unit tests.
 */
export interface CreateSessionInput {
  userId: UserId;
  agentId: AgentId;
  /** OMA environment the session runs in. Required by the main worker. */
  environmentId: string;
  /** Vault ids whose credentials should be available to this session. */
  vaultIds: ReadonlyArray<string>;
  /**
   * MCP servers the agent should have access to in this session, in addition
   * to whatever's on the agent config. Each entry's URL gets matched against
   * the vault credentials by hostname for outbound injection.
   */
  mcpServers: ReadonlyArray<{ name: string; url: string }>;
  /** Arbitrary metadata stored on the session for later observability. */
  metadata: Record<string, unknown>;
  /** First user.message-shaped event. */
  initialEvent: SessionEventInput;
}

export interface SessionEventInput {
  type: string;
  content: ReadonlyArray<{ type: string; text?: string; [k: string]: unknown }>;
  metadata?: Record<string, unknown>;
}

export interface SessionCreator {
  create(input: CreateSessionInput): Promise<{ sessionId: SessionId }>;
  /**
   * Append an event to an existing session (per_issue granularity). userId
   * is required so the host can resolve the session's tenant in O(1) without
   * scanning. Pass the same userId that owned the original `create` call.
   */
  resume(userId: UserId, sessionId: SessionId, event: SessionEventInput): Promise<void>;
}

/**
 * Bridge to OMA's vault system. Lets a provider stash an external API token
 * in the user's tenant, returning a vault id the agent's session binds to.
 * The token is then injected into outbound requests by the sandbox's outbound
 * Worker — sandbox code never sees it.
 */
export interface CreateCredentialInput {
  userId: UserId;
  /** Human-readable vault name shown in OMA Console. */
  vaultName: string;
  /** Display label for the credential row. */
  displayName: string;
  /** Hostname-matched URL the credential is injected for. */
  mcpServerUrl: string;
  /** The actual bearer token (will be encrypted in OMA's storage). */
  bearerToken: string;
}

export interface VaultManager {
  /**
   * Create a fresh vault with one static_bearer credential. Returns the
   * vault id (use as session.vault_ids) and credential id.
   */
  createCredentialForUser(
    input: CreateCredentialInput,
  ): Promise<{ vaultId: string; credentialId: string }>;
}

/**
 * Bag of generic ports a provider depends on. Constructed by the host's
 * composition root (apps/integrations/wire.ts in production) and passed into
 * each IntegrationProvider's constructor.
 *
 * Per-provider configuration (e.g. Linear App credentials) lives on the
 * provider itself, not in this Container.
 */
export interface Container {
  clock: Clock;
  ids: IdGenerator;
  crypto: Crypto;
  hmac: HmacVerifier;
  jwt: JwtSigner;
  http: HttpClient;
  sessions: SessionCreator;
  vaults: VaultManager;
  installations: InstallationRepo;
  publications: PublicationRepo;
  apps: AppRepo;
  webhookEvents: WebhookEventStore;
  issueSessions: IssueSessionRepo;
  setupLinks: SetupLinkRepo;
}
