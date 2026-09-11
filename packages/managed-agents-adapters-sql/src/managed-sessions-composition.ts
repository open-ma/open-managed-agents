import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  SessionResourceResolverService,
  type Environment,
  type DeploymentSessionLauncherPort,
  type Session,
  type SessionEventsApplicationPort,
  type SessionResourcesApplicationPort,
  type SessionsApplicationPort,
  type SessionThreadEventStreamPort,
  type SessionThreadEventsApplicationPort,
  type SessionThreadLifecycleCommandPort,
  type SessionThreadsApplicationPort,
  type SessionEnvironmentSourcePort,
} from "@open-managed-agents/managed-agents-application";
import {
  createApp,
  providePort,
  type App,
} from "@open-managed-agents/app";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "@open-managed-agents/app/capabilities";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import {
  sessionEventDispatchPort,
  sessionEventExecutionContextSourcePort,
  sessionEventSourcePort,
  sessionEventStorePort,
  sessionEventStreamPort,
  sessionEventsModule,
} from "@open-managed-agents/app/modules/session-events";
import {
  sessionResourceFileSourcePort,
  sessionResourceStorePort,
  sessionResourcesModule,
} from "@open-managed-agents/app/modules/session-resources";
import {
  sessionThreadEventStorePort,
  sessionThreadEventStreamPort,
  sessionThreadEventThreadSourcePort,
  sessionThreadEventsModule,
} from "@open-managed-agents/app/modules/session-thread-events";
import {
  sessionThreadLifecyclePort,
  sessionThreadSessionSourcePort,
  sessionThreadStorePort,
  sessionThreadsModule,
} from "@open-managed-agents/app/modules/session-threads";
import {
  deploymentSessionLauncherPort,
  sessionAgentSourcePort,
  sessionEnvironmentSourcePort,
  sessionLifecyclePort,
  sessionResourceResolverPort,
  sessionStorePort,
  sessionsModule,
} from "@open-managed-agents/app/modules/sessions";
import { WorkspaceAppRegistry } from "@open-managed-agents/platform";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import type {
  SessionEventDispatchPort,
} from "@open-managed-agents/session-runtime-contract/dispatch";
import type {
  SessionLifecycleCommandPort,
} from "@open-managed-agents/session-runtime-contract/lifecycle";
import type {
  SessionRuntimeHistorySourcePort,
} from "@open-managed-agents/session-runtime-contract/history";
import type {
  SessionEventStreamPort,
} from "@open-managed-agents/session-runtime-contract/stream";
import { createSqlSessionRuntimeReaders } from "@open-managed-agents/session-runtime-sql";
import { SqlAgentPersistence } from "./agents-sql-persistence";
import { SqlFileMetadataPersistence } from "./files-sql-persistence";
import { SqlSessionEventPersistence } from "./session-events-sql-persistence";
import { SqlMemoryStoreSource } from "./memory-store-sql-source";
import { SqlSessionPersistence } from "./sessions-sql-persistence";
import { SqlSessionResourceStore } from "@open-managed-agents/session-resource-store-sql";
import { SqlSessionRuntimeProjectionPersistence } from "./session-runtime-projection-sql-persistence";
import { SqlSessionSource } from "./session-sql-source";
import { SqlSessionThreadContextSource } from "./session-thread-context-sql-source";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";
import type { SessionResourceSecretSealer } from "./session-resource-secret-sealer";

export interface SqlManagedSessionsApplicationPorts {
  sessions: SessionsApplicationPort;
  deploymentSessionLauncher: DeploymentSessionLauncherPort;
  sessionEvents: SessionEventsApplicationPort;
  sessionResources: SessionResourcesApplicationPort;
  sessionThreads: SessionThreadsApplicationPort;
  sessionThreadEvents: SessionThreadEventsApplicationPort;
}

export type SqlManagedSessionsRuntime =
  & SessionEventDispatchPort
  & SessionThreadLifecycleCommandPort
  & SessionEventStreamPort
  & SessionThreadEventStreamPort;

export interface SqlManagedSessionsIds {
  nextSessionId(): string;
  nextEventId(): string;
  nextOutcomeId(): string;
  nextResourceId(): string;
}

export interface SqlManagedSessionsCompositionDependencies {
  client: SqlClient;
  environments: SessionEnvironmentSourcePort;
  lifecycle: SessionLifecycleCommandPort;
  runtime: SqlManagedSessionsRuntime;
  /** Optional execution-authority router for accepted input events. */
  eventDispatch?: SessionEventDispatchPort;
  /** Optional execution-authority router for live Session and thread events. */
  eventStream?: SessionEventStreamPort & SessionThreadEventStreamPort;
  sealer: SessionResourceSecretSealer;
  clock: { now(): Date };
  ids: SqlManagedSessionsIds;
  /**
   * Atomically create durable Session Execution work with accepted events.
   * Enable for lease-based Node workers. Structural single-writer runtimes
   * such as Cloudflare Durable Objects dispatch directly instead.
   */
  executionOutbox?: boolean;
}

interface SqlManagedSessionsWorkspaceApp extends App {
  readonly ports: SqlManagedSessionsApplicationPorts;
}

class ComposedSessionExecutionContextSource
  implements SessionExecutionContextSourcePort
{
  constructor(
    private readonly persisted: SessionExecutionContextSourcePort,
    private readonly sessions: SqlSessionPersistence,
    private readonly environments: SessionEnvironmentSourcePort,
  ) {}

  async find(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<{
    session: Session;
    environment: Environment;
    revision: number;
  } | null> {
    const persisted = await this.persisted.find(input);
    if (persisted !== null) return persisted;
    const stored = await this.sessions.findCurrent(input);
    if (stored === null) return null;
    const environment = await this.environments.find({
      workspaceId: input.workspaceId,
      environmentId: stored.session.environmentId,
    });
    if (environment === null) return null;
    return {
      session: stored.session,
      environment,
      revision: stored.revision,
    };
  }
}

/**
 * SQL-backed production composition for the official Sessions API.
 *
 * Concrete SQL/runtime adapters terminate here. The returned object contains
 * only application-owned inbound Ports and is safe to hand to the HTTP bundle.
 */
export class SqlManagedSessionsComposition {
  private readonly agents: SqlAgentPersistence;
  private readonly files: SqlFileMetadataPersistence;
  private readonly sessions: SqlSessionPersistence;
  private readonly sessionSource: SqlSessionSource;
  private readonly sessionEvents: SqlSessionEventPersistence;
  private readonly sessionResources: SqlSessionResourceStore;
  private readonly sessionThreads: SqlSessionThreadStore;
  private readonly sessionThreadContext: SqlSessionThreadContextSource;
  private readonly memoryStores: SqlMemoryStoreSource;
  readonly runtimeHistory: SessionRuntimeHistorySourcePort;
  readonly runtimeProjection: SqlSessionRuntimeProjectionPersistence;
  private readonly executionContext: SessionExecutionContextSourcePort;
  private readonly workspaceApps: WorkspaceAppRegistry<SqlManagedSessionsWorkspaceApp>;

  constructor(
    private readonly dependencies: SqlManagedSessionsCompositionDependencies,
  ) {
    const { client, sealer, environments } = dependencies;
    this.agents = new SqlAgentPersistence(client);
    this.files = new SqlFileMetadataPersistence(client);
    this.sessions = new SqlSessionPersistence(client, sealer, {
      executionOutbox: dependencies.executionOutbox,
    });
    this.sessionSource = new SqlSessionSource(client);
    this.sessionEvents = new SqlSessionEventPersistence(client, {
      executionOutbox: dependencies.executionOutbox,
    });
    this.sessionResources = new SqlSessionResourceStore(client, sealer);
    this.sessionThreads = new SqlSessionThreadStore(client);
    this.sessionThreadContext = new SqlSessionThreadContextSource(client);
    this.memoryStores = new SqlMemoryStoreSource(client);
    const runtimeReaders = createSqlSessionRuntimeReaders(client);
    this.runtimeHistory = runtimeReaders.history;
    this.runtimeProjection = new SqlSessionRuntimeProjectionPersistence(client);
    this.executionContext = new ComposedSessionExecutionContextSource(
      runtimeReaders.executionContext,
      this.sessions,
      environments,
    );
    this.workspaceApps = new WorkspaceAppRegistry({
      createApp: ({ workspaceId }) => this.createWorkspaceApp(workspaceId),
    });
  }

  portsFor(workspaceId: string): SqlManagedSessionsApplicationPorts {
    return this.workspaceApps.app({ workspaceId }).ports;
  }

  /** Stops and forgets every workspace-scoped application graph. */
  stopAll(): Promise<void> {
    return this.workspaceApps.stopAll();
  }

  private createWorkspaceApp(workspaceId: string): SqlManagedSessionsWorkspaceApp {
    const {
      clock,
      ids,
      lifecycle,
      runtime,
      environments,
      eventDispatch = runtime,
      eventStream = runtime,
    } = this.dependencies;
    const resources = new SessionResourceResolverService({
      files: this.files,
      memoryStores: this.memoryStores,
      ids,
    });
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId }),
        providePort(clockPort, clock),
        providePort(idGeneratorPort, {
          next: (namespace) => {
            switch (namespace) {
              case "session":
                return ids.nextSessionId();
              case "session-event":
                return ids.nextEventId();
              case "outcome":
                return ids.nextOutcomeId();
              case "session-resource":
                return ids.nextResourceId();
              default:
                throw new TypeError(
                  `Unsupported managed Sessions ID namespace: ${namespace}`,
                );
            }
          },
        }),
        providePort(sessionStorePort, this.sessions),
        providePort(sessionAgentSourcePort, this.agents),
        providePort(sessionEnvironmentSourcePort, environments),
        providePort(sessionResourceResolverPort, resources),
        providePort(sessionLifecyclePort, lifecycle),
        providePort(sessionEventStorePort, this.sessionEvents),
        providePort(sessionEventSourcePort, this.sessionSource),
        providePort(sessionEventExecutionContextSourcePort, this.executionContext),
        providePort(sessionEventStreamPort, eventStream),
        providePort(sessionEventDispatchPort, eventDispatch),
        providePort(sessionResourceStorePort, this.sessionResources),
        providePort(sessionResourceFileSourcePort, this.files),
        providePort(sessionThreadSessionSourcePort, this.sessionSource),
        providePort(sessionThreadStorePort, this.sessionThreads),
        providePort(sessionThreadLifecyclePort, runtime),
        providePort(sessionThreadEventThreadSourcePort, this.sessionThreadContext),
        providePort(sessionThreadEventStorePort, this.sessionEvents),
        providePort(sessionThreadEventStreamPort, eventStream),
        sessionsModule(),
        sessionEventsModule(),
        sessionResourcesModule(),
        sessionThreadsModule(),
        sessionThreadEventsModule(),
      ],
    });
    const sessions = app.port(managedAgentsPortTokens.sessions);
    const ports: SqlManagedSessionsApplicationPorts = {
      sessions,
      deploymentSessionLauncher: app.port(deploymentSessionLauncherPort),
      sessionEvents: app.port(managedAgentsPortTokens.sessionEvents),
      sessionResources: app.port(managedAgentsPortTokens.sessionResources),
      sessionThreads: app.port(managedAgentsPortTokens.sessionThreads),
      sessionThreadEvents: app.port(managedAgentsPortTokens.sessionThreadEvents),
    };
    return {
      get status() {
        return app.status;
      },
      ports,
      port: app.port.bind(app),
      start: app.start.bind(app),
      stop: app.stop.bind(app),
    };
  }
}
