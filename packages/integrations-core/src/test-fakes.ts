// In-memory fakes for every port and repo defined in this package.
//
// Used by downstream package tests (e.g. @open-managed-agents/linear) to
// exercise provider logic without spinning up workerd or a real Linear API.
// Adapters in integrations-adapters-cf are tested separately against real
// D1/KV via miniflare; together the two layers form the production stack.
//
// These fakes are intentionally simple: maps and arrays, no concurrency
// guards. Tests should treat each instance as single-threaded.

import type {
  AppCredentials,
  AppRepo,
  CapabilitySet,
  Clock,
  Crypto,
  CreateCommandSecretInput,
  CreateCredentialInput,
  CreateSessionInput,
  DispatchRule,
  DispatchRulePatch,
  DispatchRuleRepo,
  PendingEvent,
  PendingEventRepo,
  GitHubAppCredentials,
  GitHubAppRepo,
  HmacVerifier,
  HttpClient,
  HttpRequest,
  HttpResponse,
  IdGenerator,
  Installation,
  InstallationRepo,
  InstallKind,
  IssueSession,
  IssueSessionRepo,
  IssueSessionStatus,
  JwtSigner,
  NewAppCredentials,
  NewDispatchRule,
  NewGitHubAppCredentials,
  NewInstallation,
  NewPendingEvent,
  NewPublication,
  NewSetupLink,
  Persona,
  ProviderId,
  Publication,
  PublicationRepo,
  PublicationStatus,
  SessionCreator,
  SessionEventInput,
  SessionId,
  SessionScope,
  SessionScopeRepo,
  SessionScopeStatus,
  SetupLink,
  SetupLinkRepo,
  TenantResolver,
  VaultManager,
  WebhookEventStore,
  WorkspaceId,
} from "./index";

// ─── Runtime ports ─────────────────────────────────────────────────────

export class FakeClock implements Clock {
  constructor(private current: number = 0) {}
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;
  constructor(private prefix: string = "id") {}
  generate(): string {
    this.counter += 1;
    return `${this.prefix}_${this.counter}`;
  }
}

/** Trivial reversible "encryption" — base64 wrap. NEVER use in production. */
export class FakeCrypto implements Crypto {
  async encrypt(plaintext: string): Promise<string> {
    return `enc(${plaintext})`;
  }
  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith("enc(") || !ciphertext.endsWith(")")) {
      throw new Error(`FakeCrypto.decrypt: not a fake-cipher: ${ciphertext}`);
    }
    return ciphertext.slice(4, -1);
  }
}

export class FakeHmacVerifier implements HmacVerifier {
  /** Treats `signature` as `expected:${secret}:${body}`. */
  async verify(secret: string, body: string, signature: string): Promise<boolean> {
    return signature === `expected:${secret}:${body}`;
  }
}

export class FakeJwtSigner implements JwtSigner {
  private store = new Map<string, { payload: object; expiresAt: number }>();
  constructor(private clock: Clock = new FakeClock()) {}
  async sign(payload: object, ttlSeconds: number): Promise<string> {
    const token = `jwt_${Math.random().toString(36).slice(2)}`;
    this.store.set(token, {
      payload,
      expiresAt: this.clock.nowMs() + ttlSeconds * 1000,
    });
    return token;
  }
  async verify<T extends object = object>(token: string): Promise<T> {
    const entry = this.store.get(token);
    if (!entry) throw new Error(`FakeJwtSigner: unknown token ${token}`);
    if (this.clock.nowMs() > entry.expiresAt) {
      throw new Error(`FakeJwtSigner: expired token ${token}`);
    }
    return entry.payload as T;
  }
}

/** Records calls; replies with whatever the test queues via `respondWith`. */
export class FakeHttpClient implements HttpClient {
  readonly calls: HttpRequest[] = [];
  private queue: HttpResponse[] = [];
  private fallback: HttpResponse | null = null;

  respondWith(...responses: HttpResponse[]): this {
    this.queue.push(...responses);
    return this;
  }
  setFallback(response: HttpResponse): this {
    this.fallback = response;
    return this;
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next) return next;
    if (this.fallback) return this.fallback;
    throw new Error(`FakeHttpClient: no response queued for ${req.method} ${req.url}`);
  }
}

export class FakeSessionCreator implements SessionCreator {
  readonly created: CreateSessionInput[] = [];
  readonly resumed: { userId: string; sessionId: SessionId; event: SessionEventInput }[] = [];
  private counter = 0;

  async create(input: CreateSessionInput): Promise<{ sessionId: SessionId }> {
    this.created.push(input);
    this.counter += 1;
    return { sessionId: `sess_${this.counter}` };
  }
  async resume(userId: string, sessionId: SessionId, event: SessionEventInput): Promise<void> {
    this.resumed.push({ userId, sessionId, event });
  }
}

export class FakeVaultManager implements VaultManager {
  readonly created: CreateCredentialInput[] = [];
  readonly commandSecrets: CreateCommandSecretInput[] = [];
  readonly rotations: Array<
    | { kind: "bearer"; vaultId: string; credentialId: string; newToken: string }
    | { kind: "command_secret"; vaultId: string; credentialId: string; newToken: string }
  > = [];
  private counter = 0;

  async createCredentialForUser(
    input: CreateCredentialInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    this.created.push(input);
    this.counter += 1;
    return { vaultId: `vlt_${this.counter}`, credentialId: `crd_${this.counter}` };
  }

  async addCommandSecretCredential(
    input: CreateCommandSecretInput,
  ): Promise<{ vaultId: string; credentialId: string }> {
    this.commandSecrets.push(input);
    if (input.vaultId) {
      this.counter += 1;
      return { vaultId: input.vaultId, credentialId: `crd_${this.counter}` };
    }
    this.counter += 1;
    return { vaultId: `vlt_${this.counter}`, credentialId: `crd_${this.counter}` };
  }

  async rotateBearerToken(input: {
    userId: string;
    vaultId: string;
    newBearerToken: string;
  }): Promise<boolean> {
    this.rotations.push({
      kind: "bearer",
      vaultId: input.vaultId,
      credentialId: "(by-type)",
      newToken: input.newBearerToken,
    });
    return true;
  }

  async rotateCommandSecretToken(input: {
    userId: string;
    vaultId: string;
    envVar: string;
    newToken: string;
  }): Promise<boolean> {
    this.rotations.push({
      kind: "command_secret",
      vaultId: input.vaultId,
      credentialId: `(by-env:${input.envVar})`,
      newToken: input.newToken,
    });
    return true;
  }
}

// ─── Repositories ──────────────────────────────────────────────────────

export class InMemoryInstallationRepo implements InstallationRepo {
  private rows = new Map<string, Installation>();
  private tokens = new Map<string, string>(); // installation id → plaintext token
  private refreshTokens = new Map<string, string>(); // installation id → plaintext refresh
  private counter = 0;

  constructor(private clock: Clock = new FakeClock()) {}

  async get(id: string): Promise<Installation | null> {
    return this.rows.get(id) ?? null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    for (const row of this.rows.values()) {
      if (
        row.providerId === providerId &&
        row.workspaceId === workspaceId &&
        row.installKind === installKind &&
        row.appId === appId &&
        row.revokedAt === null
      ) {
        return row;
      }
    }
    return null;
  }

  async listByUser(userId: string, providerId: ProviderId): Promise<readonly Installation[]> {
    return [...this.rows.values()].filter(
      (r) => r.userId === userId && r.providerId === providerId && r.revokedAt === null,
    );
  }

  async getAccessToken(id: string): Promise<string | null> {
    const row = this.rows.get(id);
    if (!row || row.revokedAt !== null) return null;
    return this.tokens.get(id) ?? null;
  }

  async getRefreshToken(id: string): Promise<string | null> {
    const row = this.rows.get(id);
    if (!row || row.revokedAt !== null) return null;
    return this.refreshTokens.get(id) ?? null;
  }

  async insert(row: NewInstallation): Promise<Installation> {
    this.counter += 1;
    const id = `inst_${this.counter}`;
    const inst: Installation = {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      providerId: row.providerId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      installKind: row.installKind,
      appId: row.appId,
      botUserId: row.botUserId,
      scopes: row.scopes,
      vaultId: null,
      createdAt: this.clock.nowMs(),
      revokedAt: null,
    };
    this.rows.set(id, inst);
    this.tokens.set(id, row.accessToken);
    if (row.refreshToken) this.refreshTokens.set(id, row.refreshToken);
    return inst;
  }

  async setVaultId(id: string, vaultId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, vaultId });
  }

  async setTokens(
    id: string,
    accessToken: string,
    refreshToken: string | null,
  ): Promise<void> {
    this.tokens.set(id, accessToken);
    if (refreshToken !== null) this.refreshTokens.set(id, refreshToken);
  }

  async markRevoked(id: string, at: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, revokedAt: at });
  }
}

export class InMemoryPublicationRepo implements PublicationRepo {
  private rows = new Map<string, Publication>();
  private counter = 0;

  constructor(private clock: Clock = new FakeClock()) {}

  async get(id: string): Promise<Publication | null> {
    return this.rows.get(id) ?? null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    return [...this.rows.values()].filter((r) => r.installationId === installationId);
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    return [...this.rows.values()].filter(
      (r) => r.userId === userId && r.agentId === agentId,
    );
  }

  async insert(row: NewPublication): Promise<Publication> {
    this.counter += 1;
    const id = `pub_${this.counter}`;
    const pub: Publication = {
      id,
      ...row,
      createdAt: this.clock.nowMs(),
      unpublishedAt: null,
    };
    this.rows.set(id, pub);
    return pub;
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, status });
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, capabilities });
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, persona });
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, { ...row, status: "unpublished", unpublishedAt: at });
    }
  }
}

export class InMemoryAppRepo implements AppRepo {
  private rows = new Map<string, AppCredentials>();
  private clientSecrets = new Map<string, string>();
  private webhookSecrets = new Map<string, string>();
  private counter = 0;

  constructor(private clock: Clock = new FakeClock()) {}

  async get(id: string): Promise<AppCredentials | null> {
    return this.rows.get(id) ?? null;
  }

  async getByPublication(publicationId: string): Promise<AppCredentials | null> {
    for (const row of this.rows.values()) {
      if (row.publicationId === publicationId) return row;
    }
    return null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    return this.webhookSecrets.get(id) ?? null;
  }

  async getClientSecret(id: string): Promise<string | null> {
    return this.clientSecrets.get(id) ?? null;
  }

  async insert(row: NewAppCredentials): Promise<AppCredentials> {
    let id: string;
    if (row.id) {
      id = row.id;
    } else {
      this.counter += 1;
      id = `app_${this.counter}`;
    }
    const existing = this.rows.get(id);
    const app: AppCredentials = {
      id,
      // tenantId is preserved on upsert too — re-submits should not silently re-tenant.
      tenantId: existing ? existing.tenantId : row.tenantId,
      // Preserve publicationId on upsert (only nulled by setPublicationId)
      publicationId: existing ? existing.publicationId : row.publicationId,
      clientId: row.clientId,
      clientSecretCipher: `enc(${row.clientSecret})`,
      webhookSecretCipher: `enc(${row.webhookSecret})`,
      // Preserve createdAt on upsert
      createdAt: existing ? existing.createdAt : this.clock.nowMs(),
    };
    this.rows.set(id, app);
    this.clientSecrets.set(id, row.clientSecret);
    this.webhookSecrets.set(id, row.webhookSecret);
    return app;
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, publicationId });
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
    this.clientSecrets.delete(id);
    this.webhookSecrets.delete(id);
  }
}

export class InMemoryGitHubAppRepo implements GitHubAppRepo {
  private rows = new Map<string, GitHubAppCredentials>();
  private clientSecrets = new Map<string, string>();
  private webhookSecrets = new Map<string, string>();
  private privateKeys = new Map<string, string>();
  private counter = 0;

  constructor(private clock: Clock = new FakeClock()) {}

  async get(id: string): Promise<GitHubAppCredentials | null> {
    return this.rows.get(id) ?? null;
  }

  async getByPublication(publicationId: string): Promise<GitHubAppCredentials | null> {
    for (const row of this.rows.values()) {
      if (row.publicationId === publicationId) return row;
    }
    return null;
  }

  async getByAppId(appId: string): Promise<GitHubAppCredentials | null> {
    for (const row of this.rows.values()) {
      if (row.appId === appId) return row;
    }
    return null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    return this.webhookSecrets.get(id) ?? null;
  }

  async getClientSecret(id: string): Promise<string | null> {
    return this.clientSecrets.get(id) ?? null;
  }

  async getPrivateKey(id: string): Promise<string | null> {
    return this.privateKeys.get(id) ?? null;
  }

  async insert(row: NewGitHubAppCredentials): Promise<GitHubAppCredentials> {
    let id: string;
    if (row.id) {
      id = row.id;
    } else {
      this.counter += 1;
      id = `ghapp_${this.counter}`;
    }
    const existing = this.rows.get(id);
    const app: GitHubAppCredentials = {
      id,
      tenantId: existing ? existing.tenantId : row.tenantId,
      publicationId: existing ? existing.publicationId : row.publicationId,
      appId: row.appId,
      appSlug: row.appSlug,
      botLogin: row.botLogin,
      clientId: row.clientId,
      clientSecretCipher: row.clientSecret == null ? null : `enc(${row.clientSecret})`,
      webhookSecretCipher: `enc(${row.webhookSecret})`,
      privateKeyCipher: `enc(${row.privateKey})`,
      createdAt: existing ? existing.createdAt : this.clock.nowMs(),
    };
    this.rows.set(id, app);
    if (row.clientSecret != null) this.clientSecrets.set(id, row.clientSecret);
    this.webhookSecrets.set(id, row.webhookSecret);
    this.privateKeys.set(id, row.privateKey);
    return app;
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, publicationId });
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
    this.clientSecrets.delete(id);
    this.webhookSecrets.delete(id);
    this.privateKeys.delete(id);
  }
}

interface WebhookEventRow {
  deliveryId: string;
  tenantId: string;
  installationId: string;
  eventType: string;
  receivedAt: number;
  sessionId: string | null;
  publicationId: string | null;
  error: string | null;
}

export class InMemoryWebhookEventStore implements WebhookEventStore {
  readonly rows = new Map<string, WebhookEventRow>();

  async recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean> {
    if (this.rows.has(deliveryId)) return false;
    this.rows.set(deliveryId, {
      deliveryId,
      tenantId,
      installationId,
      eventType,
      receivedAt,
      sessionId: null,
      publicationId: null,
      error: null,
    });
    return true;
  }

  async attachSession(deliveryId: string, sessionId: string): Promise<void> {
    const row = this.rows.get(deliveryId);
    if (row) this.rows.set(deliveryId, { ...row, sessionId });
  }

  async attachPublication(deliveryId: string, publicationId: string): Promise<void> {
    const row = this.rows.get(deliveryId);
    if (row) this.rows.set(deliveryId, { ...row, publicationId });
  }

  async attachError(deliveryId: string, error: string): Promise<void> {
    const row = this.rows.get(deliveryId);
    if (row) this.rows.set(deliveryId, { ...row, error });
  }
}

export class InMemorySessionScopeRepo implements SessionScopeRepo {
  private rows = new Map<string, SessionScope>();

  private key(publicationId: string, scopeKey: string): string {
    return `${publicationId}:${scopeKey}`;
  }

  async getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null> {
    return this.rows.get(this.key(publicationId, scopeKey)) ?? null;
  }

  async insert(row: SessionScope): Promise<boolean> {
    const k = this.key(row.publicationId, row.scopeKey);
    if (this.rows.has(k)) return false;
    this.rows.set(k, row);
    return true;
  }

  async updateStatus(
    publicationId: string,
    scopeKey: string,
    status: SessionScopeStatus,
  ): Promise<void> {
    const k = this.key(publicationId, scopeKey);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status });
  }

  async listActive(publicationId: string): Promise<readonly SessionScope[]> {
    return [...this.rows.values()].filter(
      (r) => r.publicationId === publicationId && r.status === "active",
    );
  }
}

export class InMemoryIssueSessionRepo implements IssueSessionRepo {
  private rows = new Map<string, IssueSession>();

  private key(publicationId: string, issueId: string): string {
    return `${publicationId}:${issueId}`;
  }

  async getByIssue(publicationId: string, issueId: string): Promise<IssueSession | null> {
    return this.rows.get(this.key(publicationId, issueId)) ?? null;
  }

  async insert(row: IssueSession): Promise<void> {
    this.rows.set(this.key(row.publicationId, row.issueId), row);
  }

  async updateStatus(
    publicationId: string,
    issueId: string,
    status: IssueSessionStatus,
  ): Promise<void> {
    const k = this.key(publicationId, issueId);
    const row = this.rows.get(k);
    if (row) this.rows.set(k, { ...row, status });
  }

  async listActive(publicationId: string): Promise<readonly IssueSession[]> {
    return [...this.rows.values()].filter(
      (r) => r.publicationId === publicationId && r.status === "active",
    );
  }

  async claim(input: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    sessionId: SessionId;
    nowMs: number;
  }): Promise<boolean> {
    const k = this.key(input.publicationId, input.issueId);
    const existing = this.rows.get(k);
    if (existing && existing.status === "active") return false;
    this.rows.set(k, {
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      issueId: input.issueId,
      sessionId: input.sessionId,
      status: "active",
      createdAt: input.nowMs,
    });
    return true;
  }
}

export class InMemorySetupLinkRepo implements SetupLinkRepo {
  private rows = new Map<string, SetupLink>();

  async get(token: string): Promise<SetupLink | null> {
    return this.rows.get(token) ?? null;
  }

  async insert(row: NewSetupLink): Promise<SetupLink> {
    const token = `setup_${Math.random().toString(36).slice(2)}`;
    const link: SetupLink = {
      token,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt,
      usedAt: null,
      usedByEmail: null,
    };
    this.rows.set(token, link);
    return link;
  }

  async markUsed(token: string, usedByEmail: string, usedAt: number): Promise<void> {
    const row = this.rows.get(token);
    if (row) this.rows.set(token, { ...row, usedAt, usedByEmail });
  }

  async deleteExpired(now: number): Promise<number> {
    let removed = 0;
    for (const [token, row] of this.rows) {
      if (row.expiresAt < now) {
        this.rows.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

// ─── Convenience: build a complete in-memory container ────────────────

/**
 * In-memory TenantResolver. Default behavior: when a userId hasn't been
 * explicitly registered via `set(...)`, returns a derived `tn_for_<userId>`
 * tenant id rather than throwing. This keeps existing tests that don't care
 * about tenant routing working without modification — only tests that
 * specifically exercise tenant scoping need to call `set(...)`.
 *
 * The strict-throw behavior is left to the D1 adapter (D1TenantResolver),
 * which raises on missing rows because in production a missing tenant for a
 * known user is an integrity violation.
 */
export class InMemoryTenantResolver implements TenantResolver {
  private readonly mapping = new Map<string, string>();

  set(userId: string, tenantId: string): void {
    this.mapping.set(userId, tenantId);
  }

  async resolveByUserId(userId: string): Promise<string> {
    return this.mapping.get(userId) ?? `tn_for_${userId}`;
  }
}

export interface FakeContainer {
  clock: FakeClock;
  ids: FakeIdGenerator;
  crypto: FakeCrypto;
  hmac: FakeHmacVerifier;
  jwt: FakeJwtSigner;
  http: FakeHttpClient;
  tenants: InMemoryTenantResolver;
  sessions: FakeSessionCreator;
  vaults: FakeVaultManager;
  installations: InMemoryInstallationRepo;
  publications: InMemoryPublicationRepo;
  apps: InMemoryAppRepo;
  githubApps: InMemoryGitHubAppRepo;
  webhookEvents: InMemoryWebhookEventStore;
  issueSessions: InMemoryIssueSessionRepo;
  sessionScopes: InMemorySessionScopeRepo;
  setupLinks: InMemorySetupLinkRepo;
  dispatchRules: InMemoryDispatchRuleRepo;
  pendingEvents: InMemoryPendingEventRepo;
}

export function buildFakeContainer(): FakeContainer {
  const clock = new FakeClock(1_700_000_000_000);
  return {
    clock,
    ids: new FakeIdGenerator(),
    crypto: new FakeCrypto(),
    hmac: new FakeHmacVerifier(),
    jwt: new FakeJwtSigner(clock),
    http: new FakeHttpClient(),
    tenants: new InMemoryTenantResolver(),
    sessions: new FakeSessionCreator(),
    vaults: new FakeVaultManager(),
    installations: new InMemoryInstallationRepo(clock),
    publications: new InMemoryPublicationRepo(clock),
    apps: new InMemoryAppRepo(clock),
    githubApps: new InMemoryGitHubAppRepo(clock),
    webhookEvents: new InMemoryWebhookEventStore(),
    issueSessions: new InMemoryIssueSessionRepo(),
    sessionScopes: new InMemorySessionScopeRepo(),
    setupLinks: new InMemorySetupLinkRepo(),
    dispatchRules: new InMemoryDispatchRuleRepo(clock),
    pendingEvents: new InMemoryPendingEventRepo(),
  };
}

export class InMemoryDispatchRuleRepo implements DispatchRuleRepo {
  private rows = new Map<string, DispatchRule>();
  private seq = 0;
  constructor(private readonly clock: Clock = new FakeClock(1_700_000_000_000)) {}

  async get(id: string): Promise<DispatchRule | null> {
    return this.rows.get(id) ?? null;
  }

  async insert(input: NewDispatchRule): Promise<DispatchRule> {
    const id = `dr_${++this.seq}`;
    const now = this.clock.nowMs();
    const row: DispatchRule = {
      id,
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      name: input.name,
      enabled: input.enabled,
      filterLabel: input.filterLabel,
      filterStates: input.filterStates,
      filterProjectId: input.filterProjectId,
      maxConcurrent: input.maxConcurrent,
      pollIntervalSeconds: input.pollIntervalSeconds,
      lastPolledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }

  async update(id: string, patch: DispatchRulePatch): Promise<DispatchRule | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    const next: DispatchRule = {
      ...row,
      ...patch,
      updatedAt: this.clock.nowMs(),
    };
    this.rows.set(id, next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async listByPublication(publicationId: string): Promise<readonly DispatchRule[]> {
    return [...this.rows.values()]
      .filter((r) => r.publicationId === publicationId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async listDueForSweep(nowMs: number, limit: number): Promise<readonly DispatchRule[]> {
    return [...this.rows.values()]
      .filter((r) => {
        if (!r.enabled) return false;
        if (r.lastPolledAt === null) return true;
        return r.lastPolledAt + r.pollIntervalSeconds * 1000 <= nowMs;
      })
      .sort((a, b) => (a.lastPolledAt ?? 0) - (b.lastPolledAt ?? 0))
      .slice(0, limit);
  }

  async markPolled(id: string, polledAtMs: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastPolledAt: polledAtMs });
  }
}

export class InMemoryPendingEventRepo implements PendingEventRepo {
  private rows: PendingEvent[] = [];
  private seq = 0;

  async insert(input: NewPendingEvent, nowMs: number): Promise<PendingEvent> {
    const row: PendingEvent = {
      id: `pe_${++this.seq}`,
      tenantId: input.tenantId,
      publicationId: input.publicationId,
      eventKind: input.eventKind,
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      workspaceId: input.workspaceId,
      payload: input.payload,
      receivedAt: nowMs,
      processedAt: null,
      processedSessionId: null,
      errorMessage: null,
    };
    this.rows.push(row);
    return row;
  }

  async listUnprocessed(limit: number): Promise<readonly PendingEvent[]> {
    return this.rows
      .filter((r) => r.processedAt === null)
      .sort((a, b) => a.receivedAt - b.receivedAt)
      .slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) this.rows.splice(idx, 1);
  }

  async markFailed(id: string, errorMessage: string, processedAtMs: number): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rows[idx] = {
        ...this.rows[idx]!,
        processedAt: processedAtMs,
        errorMessage: errorMessage.slice(0, 2000),
      };
    }
  }

  async listByPublication(publicationId: string, limit: number): Promise<readonly PendingEvent[]> {
    return this.rows
      .filter((r) => r.publicationId === publicationId)
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, limit);
  }
}
