import type {
  EnvironmentWorkSessionCredentialIssuerPort,
  IssueEnvironmentWorkSessionCredential,
  IssueEnvironmentWorkSessionCredentialResult,
} from "@open-managed-agents/managed-agents-application";

const TOKEN_PREFIX = "sk-ant-req-v1.";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface EnvironmentWorkSessionTokenCrypto {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

export interface SealedEnvironmentWorkSessionCredentialIssuerDependencies {
  crypto: EnvironmentWorkSessionTokenCrypto;
  now(): Date;
  ttlMs?: number;
  apiBaseUrl?: string;
}

interface EnvironmentWorkSessionTokenClaims {
  version: 1;
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  issuedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  generation: number | null;
  skills: Array<{ skillId: string; version: string }>;
  files: Array<{ fileId: string }>;
  memoryStores: Array<{
    memoryStoreId: string;
    access: "read_only" | "read_write";
  }>;
}

export class SealedEnvironmentWorkSessionCredentialIssuer
  implements EnvironmentWorkSessionCredentialIssuerPort
{
  readonly #ttlMs: number;

  constructor(
    private readonly dependencies: SealedEnvironmentWorkSessionCredentialIssuerDependencies,
  ) {
    this.#ttlMs = dependencies.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("Environment Work Session credential ttlMs must be a positive integer");
    }
  }

  async issue(
    input: IssueEnvironmentWorkSessionCredential,
  ): Promise<IssueEnvironmentWorkSessionCredentialResult> {
    const issuedAt = this.dependencies.now();
    const claims: EnvironmentWorkSessionTokenClaims = {
      version: 1,
      workspaceId: input.workspaceId,
      environmentId: input.environment.id,
      sessionId: input.session.id,
      workId: input.workId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs).toISOString(),
      claimedAt: null,
      generation: null,
      skills: input.session.agent.skills.map((skill) => ({
        skillId: skill.skillId,
        version: skill.version,
      })),
      files: input.session.resources
        .filter((resource) => resource.type === "file")
        .map((resource) => ({ fileId: resource.fileId })),
      memoryStores: input.session.resources
        .filter((resource) => resource.type === "memory_store")
        .map((resource) => ({
          memoryStoreId: resource.memoryStoreId,
          access: resource.access === "read_only" ? "read_only" : "read_write",
        })),
    };
    const ciphertext = await this.dependencies.crypto.encrypt(JSON.stringify(claims));
    if (ciphertext.length === 0) {
      return { type: "rejected", message: "Session credential ciphertext is empty" };
    }
    return {
      type: "issued",
      secret: {
        sessionsToken: `${TOKEN_PREFIX}${ciphertext}`,
        ...(this.dependencies.apiBaseUrl !== undefined && {
          apiBaseUrl: this.dependencies.apiBaseUrl,
        }),
      },
    };
  }

  async bindToClaim(input: {
    secret: { sessionsToken: string; apiBaseUrl?: string };
    claimedAt: string;
    generation: number;
  }) {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error("Environment Work claim generation must be a positive integer");
    }
    if (!input.secret.sessionsToken.startsWith(TOKEN_PREFIX)) {
      throw new Error("Environment Work Session credential is not sealed");
    }
    const plaintext = await this.dependencies.crypto.decrypt(
      input.secret.sessionsToken.slice(TOKEN_PREFIX.length),
    );
    const current = parseClaims(JSON.parse(plaintext));
    if (current === null) {
      throw new Error("Environment Work Session credential is invalid");
    }
    const claimedAt = Date.parse(input.claimedAt);
    if (!Number.isFinite(claimedAt)) {
      throw new Error("Environment Work claim timestamp is invalid");
    }
    const issuedAt = this.dependencies.now();
    const next: EnvironmentWorkSessionTokenClaims = {
      ...current,
      claimedAt: new Date(claimedAt).toISOString(),
      generation: input.generation,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.#ttlMs).toISOString(),
    };
    const ciphertext = await this.dependencies.crypto.encrypt(JSON.stringify(next));
    if (ciphertext.length === 0) {
      throw new Error("Environment Work Session credential ciphertext is empty");
    }
    return {
      secret: {
        ...input.secret,
        sessionsToken: `${TOKEN_PREFIX}${ciphertext}`,
      },
    };
  }
}

export interface AuthenticateEnvironmentWorkSessionBearerInput {
  token: string;
  method: string;
  path: string;
  crypto: EnvironmentWorkSessionTokenCrypto;
  now(): Date;
  isCurrent?(claim: EnvironmentWorkSessionClaim): Promise<boolean>;
}

export interface EnvironmentWorkSessionClaim {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  claimedAt: string;
  generation: number;
  token: string;
  method: string;
  path: string;
}

export interface EnvironmentWorkSessionBearerResolution {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
  claimedAt: string;
  generation: number;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClaims(value: unknown): EnvironmentWorkSessionTokenClaims | null {
  if (!isStringRecord(value) || value.version !== 1) return null;
  for (const field of [
    "workspaceId",
    "environmentId",
    "sessionId",
    "workId",
    "issuedAt",
    "expiresAt",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) return null;
  }
  if (
    (value.claimedAt !== undefined
      && value.claimedAt !== null
      && typeof value.claimedAt !== "string")
    || !Array.isArray(value.skills)
    || (value.files !== undefined && !Array.isArray(value.files))
    || !Array.isArray(value.memoryStores)
  ) return null;
  if (
    value.generation !== undefined
    && value.generation !== null
    && (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1)
  ) return null;
  const skills: EnvironmentWorkSessionTokenClaims["skills"] = [];
  for (const skill of value.skills) {
    if (
      !isStringRecord(skill)
      || typeof skill.skillId !== "string"
      || typeof skill.version !== "string"
    ) return null;
    skills.push({ skillId: skill.skillId, version: skill.version });
  }
  const memoryStores: EnvironmentWorkSessionTokenClaims["memoryStores"] = [];
  const files: EnvironmentWorkSessionTokenClaims["files"] = [];
  for (const file of value.files ?? []) {
    if (
      !isStringRecord(file)
      || typeof file.fileId !== "string"
      || file.fileId.length === 0
    ) return null;
    files.push({ fileId: file.fileId });
  }
  for (const store of value.memoryStores) {
    if (
      !isStringRecord(store)
      || typeof store.memoryStoreId !== "string"
      || (store.access !== "read_only" && store.access !== "read_write")
    ) return null;
    memoryStores.push({ memoryStoreId: store.memoryStoreId, access: store.access });
  }
  return {
    version: 1,
    workspaceId: value.workspaceId as string,
    environmentId: value.environmentId as string,
    sessionId: value.sessionId as string,
    workId: value.workId as string,
    issuedAt: value.issuedAt as string,
    expiresAt: value.expiresAt as string,
    claimedAt: (value.claimedAt ?? null) as string | null,
    generation: (value.generation ?? null) as number | null,
    skills,
    files,
    memoryStores,
  };
}

function authorized(claims: EnvironmentWorkSessionTokenClaims, method: string, path: string): boolean {
  const parts = path.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const verb = method.toUpperCase();
  if (
    parts.length === 6
    && parts[0] === "v1"
    && parts[1] === "environments"
    && parts[2] === claims.environmentId
    && parts[3] === "work"
    && parts[4] === claims.workId
    && (parts[5] === "heartbeat" || parts[5] === "stop")
  ) return verb === "POST";

  if (
    parts[0] === "v1"
    && parts[1] === "sessions"
    && parts[2] === claims.sessionId
  ) {
    if (parts.length === 3) return verb === "GET";
    if (parts.length === 4 && parts[3] === "events") {
      return verb === "GET" || verb === "POST";
    }
    if (parts.length === 5 && parts[3] === "events" && parts[4] === "stream") {
      return verb === "GET";
    }
    return false;
  }

  // OpenMA's whole-brain harness publishes runtime-produced events through a
  // private ingress rather than the official Session input endpoint. Keep it
  // exact and write-only: the public /v1/sessions shape stays Anthropic-
  // compatible, while the per-claim `isCurrent` check fences a replaced
  // sandbox before it can mutate the canonical event log.
  if (
    parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "oma"
    && parts[2] === "sessions"
    && parts[3] === claims.sessionId
    && parts[4] === "runtime-events"
  ) return verb === "POST";

  // An in-sandbox harness must never receive an upstream MCP credential.
  // It connects to OpenMA's HTTP MCP gateway with the already-scoped Work
  // bearer instead.  The gateway path is deliberately part of the same
  // claim: reclaiming the Work rotates `sessions_token`, and `isCurrent`
  // fences the old sandbox before the gateway resolves any Vault material.
  if (
    parts.length === 5
    && parts[0] === "v1"
    && parts[1] === "oma"
    && parts[2] === "mcp-proxy"
    && parts[3] === claims.sessionId
    && parts[4]!.length > 0
  ) {
    return verb === "GET" || verb === "POST" || verb === "DELETE";
  }

  if (parts[0] === "v1" && parts[1] === "skills" && verb === "GET") {
    const skill = claims.skills.find((candidate) => candidate.skillId === parts[2]);
    if (skill === undefined) return false;
    if (parts.length === 3) return true;
    if (parts.length === 4 && parts[3] === "versions") return true;
    if (
      (parts.length === 5 || (parts.length === 6 && parts[5] === "content"))
      && parts[3] === "versions"
      && (
        parts[4] === skill.version
        || (skill.version === "latest" && /^\d+$/u.test(parts[4] ?? ""))
      )
    ) return true;
    return false;
  }

  if (
    parts[0] === "v1"
    && parts[1] === "files"
    && verb === "GET"
    && claims.files.some((candidate) => candidate.fileId === parts[2])
    && (parts.length === 3 || (parts.length === 4 && parts[3] === "content"))
  ) return true;

  if (parts[0] === "v1" && parts[1] === "memory_stores") {
    const store = claims.memoryStores.find(
      (candidate) => candidate.memoryStoreId === parts[2],
    );
    if (store === undefined) return false;
    if (parts.length === 3) return verb === "GET";
    const isRead = verb === "GET";
    const isWrite = store.access === "read_write" && (verb === "POST" || verb === "DELETE");
    if (parts[3] === "memories" && (parts.length === 4 || parts.length === 5)) {
      return isRead || isWrite;
    }
    if (parts[3] === "memory_versions" && (parts.length === 4 || parts.length === 5)) {
      return isRead;
    }
  }
  return false;
}

export async function authenticateEnvironmentWorkSessionBearer(
  input: AuthenticateEnvironmentWorkSessionBearerInput,
): Promise<EnvironmentWorkSessionBearerResolution | null> {
  if (!input.token.startsWith(TOKEN_PREFIX)) return null;
  try {
    const plaintext = await input.crypto.decrypt(input.token.slice(TOKEN_PREFIX.length));
    const claims = parseClaims(JSON.parse(plaintext));
    if (claims === null) return null;
    if (claims.claimedAt === null || claims.generation === null) return null;
    const issuedAt = Date.parse(claims.issuedAt);
    const expiresAt = Date.parse(claims.expiresAt);
    const now = input.now().getTime();
    if (
      !Number.isFinite(issuedAt)
      || !Number.isFinite(expiresAt)
      || expiresAt <= issuedAt
      || now < issuedAt
      || now >= expiresAt
    ) return null;
    if (!authorized(claims, input.method, input.path)) return null;
    if (input.isCurrent !== undefined) {
      const current = await input.isCurrent({
        workspaceId: claims.workspaceId,
        environmentId: claims.environmentId,
        sessionId: claims.sessionId,
        workId: claims.workId,
        claimedAt: claims.claimedAt,
        generation: claims.generation,
        token: input.token,
        method: input.method,
        path: input.path,
      });
      if (!current) return null;
    }
    return {
      workspaceId: claims.workspaceId,
      environmentId: claims.environmentId,
      sessionId: claims.sessionId,
      workId: claims.workId,
      claimedAt: claims.claimedAt,
      generation: claims.generation,
    };
  } catch {
    return null;
  }
}
