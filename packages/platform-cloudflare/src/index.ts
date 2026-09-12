import {
  createSqlManagedAgentsApp,
  createSqlPlatform,
  type CreateSqlPlatformOptions,
  type SqlPlatform,
  type SqlPlatformStores,
  type SqlWorkspaceScope,
} from "@open-managed-agents/platform-sql";

/** @deprecated Prefer the provider-neutral CreateSqlPlatformOptions. */
export type CreateCloudflarePlatformOptions = CreateSqlPlatformOptions;
/** @deprecated Prefer the provider-neutral SqlPlatformStores. */
export type CloudflarePlatformStores = SqlPlatformStores;
/** @deprecated Prefer the provider-neutral SqlWorkspaceScope. */
export type CloudflareWorkspaceScope = SqlWorkspaceScope;
/** @deprecated Prefer the provider-neutral SqlPlatform. */
export type CloudflarePlatform = SqlPlatform;

/**
 * Compatibility name for existing Cloudflare deployments. The composition is
 * SQL-provider neutral; Cloudflare bindings are supplied by apps/main.
 */
export const createCloudflarePlatform = createSqlPlatform;

/** Compatibility name for existing request-scoped Cloudflare entrypoints. */
export const createCloudflareManagedAgentsApp = createSqlManagedAgentsApp;
