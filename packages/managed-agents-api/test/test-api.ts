import {
  buildManagedAgentsApi,
  type ManagedAgentsApplicationPorts,
  type AgentsApplicationPort,
  type CredentialsApplicationPort,
  type DeploymentRunsApplicationPort,
  type DeploymentsApplicationPort,
  type DreamsApplicationPort,
  type EnvironmentsApplicationPort,
  type EnvironmentWorkApplicationPort,
  type FilesApplicationPort,
  type MemoriesApplicationPort,
  type MemoryStoresApplicationPort,
  type MemoryVersionsApplicationPort,
  type ModelsApplicationPort,
  type SessionEventsApplicationPort,
  type SessionResourcesApplicationPort,
  type SessionThreadEventsApplicationPort,
  type SessionThreadsApplicationPort,
  type SessionsApplicationPort,
  type SkillVersionsApplicationPort,
  type SkillsApplicationPort,
  type TunnelCertificatesApplicationPort,
  type TunnelsApplicationPort,
  type UserProfilesApplicationPort,
  type VaultsApplicationPort,
} from "../src/index";
import { makeAgentsPort } from "./fixtures";
import { makeCredentialsPort } from "./credential-fixtures";
import {
  makeDeploymentRunsPort,
  makeDeploymentsPort,
} from "./deployment-fixtures";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { makeDreamsPort } from "./dream-fixtures";
import { makeEnvironmentWorkPort } from "./environment-work-fixtures";
import { makeFilesPort } from "./file-fixtures";
import {
  makeMemoriesPort,
  makeMemoryStoresPort,
  makeMemoryVersionsPort,
} from "./memory-fixtures";
import { makeModelsPort } from "./model-fixtures";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { makeSessionResourcesPort } from "./session-resource-fixtures";
import {
  makeSessionThreadEventsPort,
  makeSessionThreadsPort,
} from "./session-thread-fixtures";
import { makeSessionsPort } from "./session-fixtures";
import { makeSkillVersionsPort, makeSkillsPort } from "./skill-fixtures";
import { makeVaultsPort } from "./vault-fixtures";
import { makeUserProfilesPort } from "./user-profile-fixtures";
import {
  makeTunnelCertificatesPort,
  makeTunnelsPort,
} from "./tunnel-fixtures";

function buildRequestScopedTestApi(
  ports: ManagedAgentsApplicationPorts,
) {
  return buildManagedAgentsApi({
    agents: () => ports.agents,
    credentials: () => ports.credentials,
    deploymentRuns: () => ports.deploymentRuns,
    deployments: () => ports.deployments,
    dreams: () => ports.dreams,
    environments: () => ports.environments,
    environmentWork: () => ports.environmentWork,
    files: () => ports.files,
    memories: () => ports.memories,
    memoryStores: () => ports.memoryStores,
    memoryVersions: () => ports.memoryVersions,
    models: () => ports.models,
    sessionEvents: () => ports.sessionEvents,
    sessionResources: () => ports.sessionResources,
    sessionThreadEvents: () => ports.sessionThreadEvents,
    sessionThreads: () => ports.sessionThreads,
    sessions: () => ports.sessions,
    skillVersions: () => ports.skillVersions,
    skills: () => ports.skills,
    tunnelCertificates: () => ports.tunnelCertificates,
    tunnels: () => ports.tunnels,
    userProfiles: () => ports.userProfiles,
    vaults: () => ports.vaults,
  });
}

/** Compose more than one real application Port for cross-resource protocol
 * tests (for example the official EnvironmentWorker, which traverses Work,
 * Sessions, and Session Events). Unspecified resources remain fail-fast
 * fixtures so the test cannot accidentally widen its dependency surface. */
export function buildManagedAgentsTestApi(
  overrides: Partial<ManagedAgentsApplicationPorts>,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
    ...overrides,
  });
}

export function buildAgentsTestApi(agents: AgentsApplicationPort) {
  return buildRequestScopedTestApi({
    agents,
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildSessionsTestApi(sessions: SessionsApplicationPort) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions,
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildSessionEventsTestApi(
  sessionEvents: SessionEventsApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents,
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildSessionResourcesTestApi(
  sessionResources: SessionResourcesApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources,
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildSessionThreadsTestApi(
  sessionThreads: SessionThreadsApplicationPort,
  sessionThreadEvents: SessionThreadEventsApplicationPort =
    makeSessionThreadEventsPort({}),
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents,
    sessionThreads,
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildEnvironmentsTestApi(
  environments: EnvironmentsApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments,
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildEnvironmentWorkTestApi(
  environmentWork: EnvironmentWorkApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork,
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildVaultsTestApi(vaults: VaultsApplicationPort) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults,
  });
}

export function buildCredentialsTestApi(
  credentials: CredentialsApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials,
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildFilesTestApi(files: FilesApplicationPort) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files,
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildSkillsTestApi(
  skills: SkillsApplicationPort,
  skillVersions: SkillVersionsApplicationPort = makeSkillVersionsPort({}),
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions,
    skills,
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildMemoryTestApi(ports: {
  memoryStores?: MemoryStoresApplicationPort;
  memories?: MemoriesApplicationPort;
  memoryVersions?: MemoryVersionsApplicationPort;
}) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: ports.memories ?? makeMemoriesPort({}),
    memoryStores: ports.memoryStores ?? makeMemoryStoresPort({}),
    memoryVersions: ports.memoryVersions ?? makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildDeploymentsTestApi(ports: {
  deployments?: DeploymentsApplicationPort;
  deploymentRuns?: DeploymentRunsApplicationPort;
}) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: ports.deploymentRuns ?? makeDeploymentRunsPort({}),
    deployments: ports.deployments ?? makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildUserProfilesTestApi(
  userProfiles: UserProfilesApplicationPort,
) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles,
    vaults: makeVaultsPort({}),
  });
}

export function buildTunnelsTestApi(ports: {
  tunnels?: TunnelsApplicationPort;
  tunnelCertificates?: TunnelCertificatesApplicationPort;
}) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates:
      ports.tunnelCertificates ?? makeTunnelCertificatesPort({}),
    tunnels: ports.tunnels ?? makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildDreamsTestApi(dreams: DreamsApplicationPort) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams,
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models: makeModelsPort({}),
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}

export function buildModelsTestApi(models: ModelsApplicationPort) {
  return buildRequestScopedTestApi({
    agents: makeAgentsPort({}),
    credentials: makeCredentialsPort({}),
    deploymentRuns: makeDeploymentRunsPort({}),
    deployments: makeDeploymentsPort({}),
    dreams: makeDreamsPort({}),
    environments: makeEnvironmentsPort({}),
    environmentWork: makeEnvironmentWorkPort({}),
    files: makeFilesPort({}),
    memories: makeMemoriesPort({}),
    memoryStores: makeMemoryStoresPort({}),
    memoryVersions: makeMemoryVersionsPort({}),
    models,
    sessionEvents: makeSessionEventsPort({}),
    sessionResources: makeSessionResourcesPort({}),
    sessionThreadEvents: makeSessionThreadEventsPort({}),
    sessionThreads: makeSessionThreadsPort({}),
    sessions: makeSessionsPort({}),
    skillVersions: makeSkillVersionsPort({}),
    skills: makeSkillsPort({}),
    tunnelCertificates: makeTunnelCertificatesPort({}),
    tunnels: makeTunnelsPort({}),
    userProfiles: makeUserProfilesPort({}),
    vaults: makeVaultsPort({}),
  });
}
