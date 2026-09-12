import { SqlAgentStore } from "@open-managed-agents/agent-store-sql";
import type { AgentStore } from "@open-managed-agents/agent-store";
import { createApp, providePort, type App, type AppModule } from "@open-managed-agents/app";
import {
  managedAgentsFeatureModules,
  type ManagedAgentsFeatures,
} from "@open-managed-agents/app/features";
import {
  clockPort,
  httpClientPort,
  idGeneratorPort,
  workspaceContextPort,
  type ClockPort,
  type HttpClientPort,
  type IdGeneratorPort,
} from "@open-managed-agents/app/capabilities";
import { agentStorePort } from "@open-managed-agents/app/modules/agents";
import { deploymentStorePort } from "@open-managed-agents/app/modules/deployments";
import { deploymentRunStorePort } from "@open-managed-agents/app/modules/deployment-runs";
import { dreamStorePort } from "@open-managed-agents/app/modules/dreams";
import {
  credentialStorePort,
  credentialValidationProbePort,
  credentialVaultSourcePort,
} from "@open-managed-agents/app/modules/credentials";
import { environmentStorePort } from "@open-managed-agents/app/modules/environments";
import { environmentWorkStorePort } from "@open-managed-agents/app/modules/environment-work";
import { fileContentStorePort, fileStorePort } from "@open-managed-agents/app/modules/files";
import { memoryStoreStorePort } from "@open-managed-agents/app/modules/memory-stores";
import { memoryDocumentStorePort } from "@open-managed-agents/app/modules/memories";
import { skillStorePort } from "@open-managed-agents/app/modules/skills";
import { tunnelStorePort } from "@open-managed-agents/app/modules/tunnels";
import { userProfileStorePort } from "@open-managed-agents/app/modules/user-profiles";
import { sessionEventStorePort } from "@open-managed-agents/app/modules/session-events";
import { sessionResourceStorePort } from "@open-managed-agents/app/modules/session-resources";
import { sessionThreadEventStorePort } from "@open-managed-agents/app/modules/session-thread-events";
import { sessionThreadStorePort } from "@open-managed-agents/app/modules/session-threads";
import { sessionStorePort } from "@open-managed-agents/app/modules/sessions";
import { credentialVaultSourceFromVaultStore, vaultStorePort } from "@open-managed-agents/app/modules/vaults";
import {
  resolveWorkspaceValue,
  WorkspaceAppRegistry,
  type WorkspaceScope,
  type WorkspaceValue,
} from "@open-managed-agents/platform";
import { SqlSessionEventStore } from "@open-managed-agents/session-event-store-sql";
import type { SessionEventStore } from "@open-managed-agents/session-event-store";
import { SqlSessionStore, type SessionResourceSecretSealer } from "@open-managed-agents/session-store-sql";
import type { SessionStore } from "@open-managed-agents/session-store";
import type { SessionResourceStore } from "@open-managed-agents/session-resource-store";
import { SqlSessionResourceStore } from "@open-managed-agents/session-resource-store-sql";
import type { SessionThreadStore } from "@open-managed-agents/session-thread-store";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import { SqlEnvironmentStore } from "@open-managed-agents/environment-store-sql";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import { SqlEnvironmentWorkStore, type EnvironmentWorkSecretCipher } from "@open-managed-agents/environment-work-store-sql";
import type { FileStore } from "@open-managed-agents/file-store";
import { SqlFileStore } from "@open-managed-agents/file-store-sql";
import type { FileContentStore } from "@open-managed-agents/file-content-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import { SqlCredentialStore, type CredentialDocumentCipher } from "@open-managed-agents/credential-store-sql";
import type { DeploymentStore } from "@open-managed-agents/deployment-store";
import { SqlDeploymentStore, type DeploymentResourceSecretCipher } from "@open-managed-agents/deployment-store-sql";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import { SqlDeploymentRunStore } from "@open-managed-agents/deployment-run-store-sql";
import type { DreamStore } from "@open-managed-agents/dream-store";
import { SqlDreamStore } from "@open-managed-agents/dream-store-sql";
import type { VaultStore } from "@open-managed-agents/vault-store";
import { SqlVaultStore } from "@open-managed-agents/vault-store-sql";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import { SqlMemoryStoreStore } from "@open-managed-agents/memory-store-store-sql";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import { SqlMemoryDocumentStore } from "@open-managed-agents/memory-document-store-sql";
import type { SkillStore } from "@open-managed-agents/skill-store";
import { SqlSkillStore } from "@open-managed-agents/skill-store-sql";
import type { TunnelStore } from "@open-managed-agents/tunnel-store";
import { SqlTunnelStore } from "@open-managed-agents/tunnel-store-sql";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import { SqlUserProfileStore } from "@open-managed-agents/user-profile-store-sql";
import type {
  CredentialValidationProbePort,
  CredentialVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";

export interface CreateSqlPlatformOptions {
  features?: ManagedAgentsFeatures | false;
  sql?: WorkspaceValue<SqlClient>;
  credentialCipher?: WorkspaceValue<CredentialDocumentCipher>;
  deploymentCipher?: WorkspaceValue<DeploymentResourceSecretCipher>;
  environmentWorkCipher?: WorkspaceValue<EnvironmentWorkSecretCipher>;
  credentialVaults?: WorkspaceValue<CredentialVaultSourcePort>;
  credentialValidation?: WorkspaceValue<CredentialValidationProbePort>;
  fileContent?: WorkspaceValue<FileContentStore>;
  sessionSecrets?: SessionResourceSecretSealer;
  stores?: WorkspaceValue<Partial<SqlPlatformStores>>;
  clock?: ClockPort;
  ids?: IdGeneratorPort;
  http?: HttpClientPort;
  modules?(scope: WorkspaceScope): readonly AppModule[];
}

export interface SqlPlatformStores {
  agents: AgentStore;
  credentials: CredentialStore;
  deployments: DeploymentStore;
  deploymentRuns: DeploymentRunStore;
  dreams: DreamStore;
  environments: EnvironmentStore;
  environmentWork: EnvironmentWorkStore;
  files: FileStore;
  memoryStores: MemoryStoreStore;
  memories: MemoryDocumentStore;
  skills: SkillStore;
  tunnels: TunnelStore;
  userProfiles: UserProfileStore;
  sessions: SessionStore;
  sessionResources: SessionResourceStore;
  sessionEvents: SessionEventStore;
  sessionThreads: SessionThreadStore;
  vaults: VaultStore;
}

export interface SqlWorkspaceScope extends WorkspaceScope {
  sql?: SqlClient;
  fileContent?: FileContentStore;
  credentialCipher?: CredentialDocumentCipher;
  deploymentCipher?: DeploymentResourceSecretCipher;
  environmentWorkCipher?: EnvironmentWorkSecretCipher;
  credentialVaults?: CredentialVaultSourcePort;
  credentialValidation?: CredentialValidationProbePort;
  modules?: readonly AppModule[];
}

export interface SqlPlatform {
  readonly apps: WorkspaceAppRegistry<App, SqlWorkspaceScope>;
  app(scope: SqlWorkspaceScope): App;
  existing(workspaceId: string): App | undefined;
  stop(workspaceId: string): Promise<boolean>;
  stopAll(): Promise<void>;
}

export function createSqlPlatform(options: CreateSqlPlatformOptions = {}): SqlPlatform {
  const clock = options.clock ?? { now: () => new Date() };
  const ids = options.ids ?? { next: (namespace: string) => `${namespace}_${randomUuid()}` };
  const http = options.http ?? {
    fetch: (input: string | Request, init?: RequestInit) => globalThis.fetch(input, init),
  };
  const sessionSecrets = options.sessionSecrets ?? {
    seal: async (): Promise<string> => {
      throw new Error("SQL Session persistence requires a sessionSecrets sealer");
    },
  };
  const apps = new WorkspaceAppRegistry<App, SqlWorkspaceScope>({
    createApp(scope) {
      const sql = scope.sql ?? (options.sql === undefined
        ? undefined
        : resolveWorkspaceValue(options.sql, scope));
      if (sql === undefined) {
        throw new TypeError("SQL workspace app requires sql in the platform options or workspace scope");
      }
      const overrides = options.stores === undefined ? {} : resolveWorkspaceValue(options.stores, scope);
      const credentialCipher = scope.credentialCipher
        ?? (options.credentialCipher === undefined
          ? unavailableCredentialCipher
          : resolveWorkspaceValue(options.credentialCipher, scope));
      const deploymentCipher = scope.deploymentCipher
        ?? (options.deploymentCipher === undefined
          ? unavailableDeploymentCipher
          : resolveWorkspaceValue(options.deploymentCipher, scope));
      const environmentWorkCipher = scope.environmentWorkCipher
        ?? (options.environmentWorkCipher === undefined
          ? unavailableEnvironmentWorkCipher
          : resolveWorkspaceValue(options.environmentWorkCipher, scope));
      const sessions = overrides.sessions ?? new SqlSessionStore(sql, sessionSecrets);
      const stores: SqlPlatformStores = {
        agents: overrides.agents ?? new SqlAgentStore(sql),
        credentials: overrides.credentials ?? new SqlCredentialStore(sql, credentialCipher),
        deployments: overrides.deployments ?? new SqlDeploymentStore(sql, deploymentCipher),
        deploymentRuns: overrides.deploymentRuns ?? new SqlDeploymentRunStore(sql),
        dreams: overrides.dreams ?? new SqlDreamStore(sql),
        environments: overrides.environments ?? new SqlEnvironmentStore(sql),
        environmentWork: overrides.environmentWork ?? new SqlEnvironmentWorkStore(sql, environmentWorkCipher),
        files: overrides.files ?? new SqlFileStore(sql),
        memoryStores: overrides.memoryStores ?? new SqlMemoryStoreStore(sql),
        memories: overrides.memories ?? new SqlMemoryDocumentStore(sql),
        skills: overrides.skills ?? new SqlSkillStore(sql),
        tunnels: overrides.tunnels ?? new SqlTunnelStore(sql),
        userProfiles: overrides.userProfiles ?? new SqlUserProfileStore(sql),
        sessions,
        sessionResources: overrides.sessionResources ?? new SqlSessionResourceStore(sql, sessionSecrets),
        sessionEvents: overrides.sessionEvents ?? new SqlSessionEventStore(sql),
        sessionThreads: overrides.sessionThreads ?? new SqlSessionThreadStore(sql),
        vaults: overrides.vaults ?? new SqlVaultStore(sql),
      };
      const fileContent = scope.fileContent ?? (options.fileContent === undefined
        ? undefined
        : resolveWorkspaceValue(options.fileContent, scope));
      const credentialVaults = scope.credentialVaults
        ?? (options.credentialVaults === undefined
          ? credentialVaultSourceFromVaultStore(stores.vaults)
          : resolveWorkspaceValue(options.credentialVaults, scope));
      const credentialValidation = scope.credentialValidation
        ?? (options.credentialValidation === undefined
          ? undefined
          : resolveWorkspaceValue(options.credentialValidation, scope));
      return createApp({
        modules: [
          providePort(workspaceContextPort, { workspaceId: scope.workspaceId }),
          providePort(clockPort, clock),
          providePort(idGeneratorPort, ids),
          providePort(httpClientPort, http),
          providePort(agentStorePort, stores.agents),
          providePort(credentialStorePort, stores.credentials),
          providePort(deploymentStorePort, stores.deployments),
          providePort(deploymentRunStorePort, stores.deploymentRuns),
          providePort(dreamStorePort, stores.dreams),
          providePort(credentialVaultSourcePort, credentialVaults),
          ...(credentialValidation === undefined
            ? []
            : [providePort(credentialValidationProbePort, credentialValidation)]),
          providePort(environmentStorePort, stores.environments),
          providePort(environmentWorkStorePort, stores.environmentWork),
          providePort(fileStorePort, stores.files),
          ...(fileContent === undefined ? [] : [providePort(fileContentStorePort, fileContent)]),
          providePort(memoryStoreStorePort, stores.memoryStores),
          providePort(memoryDocumentStorePort, stores.memories),
          providePort(skillStorePort, stores.skills),
          providePort(tunnelStorePort, stores.tunnels),
          providePort(userProfileStorePort, stores.userProfiles),
          providePort(sessionStorePort, stores.sessions),
          providePort(sessionResourceStorePort, stores.sessionResources),
          providePort(sessionEventStorePort, stores.sessionEvents),
          providePort(sessionThreadStorePort, stores.sessionThreads),
          providePort(sessionThreadEventStorePort, stores.sessionEvents),
          providePort(vaultStorePort, stores.vaults),
          ...(scope.modules ?? []),
          ...(options.modules?.(scope) ?? []),
          ...managedAgentsFeatureModules(options.features),
        ],
      });
    },
  });
  return {
    apps,
    app: apps.app.bind(apps),
    existing: apps.existing.bind(apps),
    stop: apps.stop.bind(apps),
    stopAll: apps.stopAll.bind(apps),
  };
}

export function createSqlManagedAgentsApp(
  scope: SqlWorkspaceScope,
  options: CreateSqlPlatformOptions = {},
): App {
  return createSqlPlatform(options).app(scope);
}

const unavailableCredentialCipher: CredentialDocumentCipher = {
  seal: async () => { throw new Error("SQL Credential persistence requires a credentialCipher"); },
  open: async () => { throw new Error("SQL Credential persistence requires a credentialCipher"); },
};

const unavailableDeploymentCipher: DeploymentResourceSecretCipher = {
  seal: async () => { throw new Error("SQL Deployment persistence requires a deploymentCipher"); },
  open: async () => { throw new Error("SQL Deployment persistence requires a deploymentCipher"); },
};

const unavailableEnvironmentWorkCipher: EnvironmentWorkSecretCipher = {
  seal: async () => { throw new Error("SQL Environment Work persistence requires an environmentWorkCipher"); },
  open: async () => { throw new Error("SQL Environment Work persistence requires an environmentWorkCipher"); },
};

function randomUuid(): string {
  const cryptoApi = (globalThis as typeof globalThis & { crypto?: { randomUUID(): string } }).crypto;
  if (cryptoApi === undefined) throw new Error("The SQL platform requires crypto.randomUUID or an ids Port");
  return cryptoApi.randomUUID();
}
