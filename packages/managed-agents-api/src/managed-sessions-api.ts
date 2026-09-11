import { Hono } from "hono";
import type { ApplicationPortSource } from "./application-port-source";
import type { ManagedAgentsApplicationPorts } from "./ports";
import { buildSessionEventRoutes } from "./routes/session-events";
import {
  buildManagedSessionOutputRoutes,
  type ManagedSessionOutputsExtension,
} from "./routes/session-outputs";
import { buildSessionResourceRoutes } from "./routes/session-resources";
import { buildSessionThreadRoutes } from "./routes/session-threads";
import { buildSessionRoutes } from "./routes/sessions";

export type ManagedSessionsApplicationPorts = Pick<
  ManagedAgentsApplicationPorts,
  | "sessions"
  | "sessionEvents"
  | "sessionResources"
  | "sessionThreads"
  | "sessionThreadEvents"
>;

export type ManagedSessionsApplicationPortSources = {
  [Name in keyof ManagedSessionsApplicationPorts]: ApplicationPortSource<
    ManagedSessionsApplicationPorts[Name]
  >;
};

export interface ManagedSessionsApiExtensions {
  outputs?: ManagedSessionOutputsExtension;
}

/**
 * Builds the official Managed Agents Sessions surface relative to `/v1/sessions`.
 * Every dependency is an application-owned inbound Port or a request-scoped
 * resolver for one; HTTP composition cannot reach persistence or runtime directly.
 */
export function buildManagedSessionsApi(
  ports: ManagedSessionsApplicationPortSources,
  extensions: ManagedSessionsApiExtensions = {},
): Hono {
  const app = new Hono();
  if (extensions.outputs !== undefined) {
    app.route(
      "/",
      buildManagedSessionOutputRoutes(ports.sessions, extensions.outputs),
    );
  }
  app.route("/", buildSessionRoutes(ports.sessions));
  app.route("/", buildSessionEventRoutes(ports.sessionEvents));
  app.route("/", buildSessionResourceRoutes(ports.sessionResources));
  app.route(
    "/",
    buildSessionThreadRoutes(ports.sessionThreads, ports.sessionThreadEvents),
  );
  return app;
}
