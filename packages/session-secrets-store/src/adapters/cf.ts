// Cloudflare KV adapter for the session-secrets store.
//
// Why KV (intentional — see the package README): per-session secrets are
// read by SessionDO at session warmup as a small read-only blob. The sandbox
// container runs in a separate worker context that doesn't have full D1
// bindings, and these values die with the session via cascade delete. KV is
// the right shape for "session-scoped read-only secret view" — but the
// *interface* (SessionSecretRepo) is decoupled so a future Redis / per-tenant
// adapter can swap here without touching consumer code.
//
// This file is the ONLY place in the package that imports
// `@cloudflare/workers-types` (KVNamespace etc.). Everything else stays
// runtime-agnostic.

import type { Env } from "@open-managed-agents/shared";
import type { SessionSecretRepo } from "../ports";
import { SessionSecretService } from "../service";

export class KvSessionSecretRepo implements SessionSecretRepo {
  constructor(private readonly kv: KVNamespace) {}

  async put(
    tenantId: string,
    sessionId: string,
    resourceId: string,
    value: string,
  ): Promise<void> {
    await this.kv.put(this.keyFor(tenantId, sessionId, resourceId), value);
  }

  async get(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<string | null> {
    return this.kv.get(this.keyFor(tenantId, sessionId, resourceId));
  }

  async deleteOne(
    tenantId: string,
    sessionId: string,
    resourceId: string,
  ): Promise<void> {
    await this.kv.delete(this.keyFor(tenantId, sessionId, resourceId));
  }

  /**
   * Walk the `t:{tenant}:secret:{session}:` namespace and DELETE every key.
   *
   * Pagination: KV.list returns at most 1000 keys per call. We follow the
   * cursor until `list_complete: true`. A session could in theory have many
   * resources, so a single list+delete pass isn't safe — we MUST loop.
   *
   * Safety: deletes are issued in parallel within a page (Promise.all) but
   * pages are sequential — KV's eventual consistency means a key we just
   * inserted might not appear in `list` for a few seconds, but for the
   * session-delete cascade that's fine: the session is gone, no consumer is
   * adding more secrets concurrently.
   */
  async deleteAllForSession(
    tenantId: string,
    sessionId: string,
  ): Promise<number> {
    const prefix = this.prefixFor(tenantId, sessionId);
    let cursor: string | undefined;
    let total = 0;
    do {
      const page = await this.kv.list({ prefix, cursor });
      if (page.keys.length) {
        await Promise.all(page.keys.map((k) => this.kv.delete(k.name)));
        total += page.keys.length;
      }
      // KVNamespaceListResult has `list_complete: boolean` plus `cursor`
      // when there's more. Stop the loop the moment list_complete is true,
      // even if `cursor` is somehow still set, to avoid an infinite walk.
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return total;
  }

  private keyFor(tenantId: string, sessionId: string, resourceId: string): string {
    return `t:${tenantId}:secret:${sessionId}:${resourceId}`;
  }

  private prefixFor(tenantId: string, sessionId: string): string {
    return `t:${tenantId}:secret:${sessionId}:`;
  }
}

/**
 * Production wiring: build a SessionSecretService backed by `env.CONFIG_KV`.
 *
 * Used by `buildCfServices` in packages/services + by anything outside the
 * Hono request scope (SessionDO, outbound worker, cron) that needs to access
 * session secrets without depending on the KV binding directly.
 */
export function createCfSessionSecretService(
  env: Pick<Env, "CONFIG_KV">,
): SessionSecretService {
  return new SessionSecretService({
    repo: new KvSessionSecretRepo(env.CONFIG_KV),
  });
}
