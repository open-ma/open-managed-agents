import { Hono } from "hono";
import type { ApplicationPortSource } from "./application-port-source";
export type {
  ApplicationPortResolver,
  ApplicationPortSource,
} from "./application-port-source";
import type { ManagedAgentsApplicationPorts } from "./ports";
import { buildManagedSessionsApi } from "./managed-sessions-api";
import { buildAgentRoutes } from "./routes/agents";
import { buildCredentialRoutes } from "./routes/credentials";
import { buildDeploymentRunRoutes } from "./routes/deployment-runs";
import { buildDeploymentRoutes } from "./routes/deployments";
import { buildDreamRoutes } from "./routes/dreams";
import { buildEnvironmentRoutes } from "./routes/environments";
import { buildEnvironmentWorkRoutes } from "./routes/environment-work";
import { buildFileRoutes } from "./routes/files";
import { buildMemoryRoutes } from "./routes/memories";
import { buildMemoryStoreRoutes } from "./routes/memory-stores";
import { buildMemoryVersionRoutes } from "./routes/memory-versions";
import { buildModelRoutes } from "./routes/models";
import { buildSkillVersionRoutes } from "./routes/skill-versions";
import { buildSkillRoutes } from "./routes/skills";
import { buildVaultRoutes } from "./routes/vaults";
import { buildUserProfileRoutes } from "./routes/user-profiles";
import { buildTunnelCertificateRoutes } from "./routes/tunnel-certificates";
import { buildTunnelRoutes } from "./routes/tunnels";

export type { AgentCreateBody } from "./contracts/agents";
export type * from "./ports";
export {
  buildManagedSessionsApi,
  type ManagedSessionsApiExtensions,
  type ManagedSessionsApplicationPorts,
  type ManagedSessionsApplicationPortSources,
} from "./managed-sessions-api";
export {
  buildManagedSessionOutputRoutes,
  type ManagedSessionOutputReadResult,
  type ManagedSessionOutputsExtension,
  type ManagedSessionOutputsStore,
  type ManagedSessionOutputView,
} from "./routes/session-outputs";
export { buildAgentRoutes } from "./routes/agents";
export { buildCredentialRoutes } from "./routes/credentials";
export { buildDeploymentRunRoutes } from "./routes/deployment-runs";
export { buildDeploymentRoutes } from "./routes/deployments";
export { buildDreamRoutes } from "./routes/dreams";
export { buildEnvironmentRoutes } from "./routes/environments";
export { buildEnvironmentWorkRoutes } from "./routes/environment-work";
export { buildFileRoutes } from "./routes/files";
export { buildMemoryStoreRoutes } from "./routes/memory-stores";
export { buildMemoryRoutes } from "./routes/memories";
export { buildMemoryVersionRoutes } from "./routes/memory-versions";
export { buildModelRoutes } from "./routes/models";
export { buildVaultRoutes } from "./routes/vaults";
export { buildSessionEventRoutes } from "./routes/session-events";
export { buildSessionResourceRoutes } from "./routes/session-resources";
export { buildSessionThreadRoutes } from "./routes/session-threads";
export { buildSessionRoutes } from "./routes/sessions";
export { buildSkillRoutes } from "./routes/skills";
export { buildSkillVersionRoutes } from "./routes/skill-versions";
export { buildTunnelRoutes } from "./routes/tunnels";
export { buildTunnelCertificateRoutes } from "./routes/tunnel-certificates";
export { buildUserProfileRoutes } from "./routes/user-profiles";
export type {
  AgentsApplicationPortResolver,
  AgentsApplicationPortSource,
} from "./routes/agents";

export type ManagedAgentsApplicationPortSources = {
  [Name in keyof ManagedAgentsApplicationPorts]: ApplicationPortSource<
    ManagedAgentsApplicationPorts[Name]
  >;
};

export function buildManagedAgentsApi(
  ports: ManagedAgentsApplicationPortSources,
): Hono {
  const app = new Hono();
  app.route("/v1/agents", buildAgentRoutes(ports.agents));
  app.route("/v1/vaults", buildCredentialRoutes(ports.credentials));
  app.route(
    "/v1/deployment_runs",
    buildDeploymentRunRoutes(ports.deploymentRuns),
  );
  app.route("/v1/deployments", buildDeploymentRoutes(ports.deployments));
  app.route("/v1/dreams", buildDreamRoutes(ports.dreams));
  app.route("/v1/environments", buildEnvironmentRoutes(ports.environments));
  app.route(
    "/v1/environments",
    buildEnvironmentWorkRoutes(ports.environmentWork),
  );
  app.route("/v1/files", buildFileRoutes(ports.files));
  app.route("/v1/memory_stores", buildMemoryStoreRoutes(ports.memoryStores));
  app.route("/v1/memory_stores", buildMemoryRoutes(ports.memories));
  app.route(
    "/v1/memory_stores",
    buildMemoryVersionRoutes(ports.memoryVersions),
  );
  app.route("/v1/models", buildModelRoutes(ports.models));
  app.route(
    "/v1/sessions",
    buildManagedSessionsApi({
      sessions: ports.sessions,
      sessionEvents: ports.sessionEvents,
      sessionResources: ports.sessionResources,
      sessionThreads: ports.sessionThreads,
      sessionThreadEvents: ports.sessionThreadEvents,
    }),
  );
  app.route("/v1/skills", buildSkillRoutes(ports.skills));
  app.route("/v1/skills", buildSkillVersionRoutes(ports.skillVersions));
  app.route("/v1/tunnels", buildTunnelRoutes(ports.tunnels));
  app.route(
    "/v1/tunnels",
    buildTunnelCertificateRoutes(ports.tunnelCertificates),
  );
  app.route(
    "/v1/user_profiles",
    buildUserProfileRoutes(ports.userProfiles),
  );
  app.route("/v1/vaults", buildVaultRoutes(ports.vaults));
  return app;
}
