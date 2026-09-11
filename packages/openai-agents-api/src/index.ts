import { Hono } from "hono";
import { buildOpenAISessionRoutes, type SessionPortSource } from "./sessions";
import { buildOpenAIVaultRoutes, type VaultPortSource } from "./vaults";

export type * from "./ports";
export * from "./full";
export * from "./full-operations";
export * from "./full-contracts";
export { buildOpenAISessionRoutes, type SessionPortSource } from "./sessions";
export { buildOpenAIVaultRoutes, type VaultPortSource } from "./vaults";

export function buildOpenAIAgentsApi(ports: { sessions: SessionPortSource; vaults?: VaultPortSource }): Hono {
  const app = new Hono();
  app.route("/v1/agents/sessions", buildOpenAISessionRoutes(ports.sessions));
  if (ports.vaults) app.route("/v1/vaults", buildOpenAIVaultRoutes(ports.vaults));
  return app;
}
