// CF session-lifecycle hooks — wraps the CF-only helpers
// (USAGE_METER gate, GitHub binding fast-path,
// refreshProviderCredentialsForSession, R2 file copy + outputs cascade)
// behind the runtime-agnostic `SessionLifecycleHooks` shape that
// `@open-managed-agents/http-routes`'s sessions package consumes.
//
// All hooks are best-effort: a failure in any of them (USAGE_METER outage,
// integrations gateway 5xx, etc.) returns a fail-open value matching the
// legacy inline behavior — see the comments on each hook.

import type { Env, ContentBlock, SessionEvent, CredentialConfig } from "@open-managed-agents/shared";
import type { Context } from "hono";
import {
  generateFileId,
  fileR2Key,
  sessionOutputsPrefix,
  logWarn,
  recordEvent,
  errFields,
  classifyExternalError,
} from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import type { SessionLifecycleHooks } from "@open-managed-agents/http-routes";
import { toFileRecord } from "@open-managed-agents/files-store";
import { rateLimitSessionCreate } from "../rate-limit";
import { checkDailySessionCap } from "../quotas";

/** Build the per-request lifecycle hooks bundle. */
export function cfSessionLifecycle(c: Context): SessionLifecycleHooks {
  const env = c.env as Env;
  const services = (c.var as unknown as { services: Services }).services;
  return {
    preCreateRateLimit: async ({ tenantId }) => {
      const rl = await rateLimitSessionCreate(env, tenantId);
      if (rl) return { status: rl.status, body: await rl.json() };
      const daily = await checkDailySessionCap(env, services.kv, tenantId);
      if (daily) return { status: daily.status, body: await daily.json() };
      return null;
    },
    preCreateGate: async ({ tenantId, agentId, isLocalRuntime }) => {
      // USAGE_METER.canStartSandbox — fail open when the meter is unbound or
      // returns an exception (matches legacy behavior, sessions still start).
      type UsageMeterRpc = {
        canStartSandbox(o: { tenantId: string; agentId?: string }): Promise<{
          ok: boolean;
          reason?: string;
          balance_cents?: number;
        }>;
      };
      const meter = (env as unknown as { USAGE_METER?: UsageMeterRpc }).USAGE_METER;
      if (!meter || isLocalRuntime) return null;
      try {
        const gate = await meter.canStartSandbox({ tenantId, agentId });
        if (!gate.ok) {
          return {
            status: 402,
            body: {
              error: gate.reason ?? "Sandbox launch refused by usage meter",
              balance_cents: gate.balance_cents ?? 0,
            },
          };
        }
      } catch (err) {
        const classified = classifyExternalError(err);
        const e = classified instanceof Error ? classified : err;
        console.error(
          `[sessions] USAGE_METER.canStartSandbox failed [${(e as Error)?.name ?? "unknown"}]: ${(e as Error)?.message ?? e}`,
        );
      }
      return null;
    },
    refreshSessionCredentials: async ({ tenantId, agentId, vaultIds }) => {
      return refreshProviderCredentialsForSession(
        env,
        services,
        tenantId,
        agentId,
        vaultIds,
      );
    },
    githubBindingFastPath: async ({ tenantId, repoUrl }) => {
      return tryGitHubBindingFastPath(env, tenantId, repoUrl);
    },
    notifyDaemonDispose: async ({ runtimeId, sessionId }) => {
      if (!env.RUNTIME_ROOM) return;
      try {
        const stub = env.RUNTIME_ROOM.get(env.RUNTIME_ROOM.idFromName(runtimeId));
        await (
          stub as unknown as {
            sendToDaemon(msg: Record<string, unknown>): Promise<boolean>;
          }
        ).sendToDaemon({ type: "session.dispose", session_id: sessionId });
      } catch (err) {
        logWarn(
          { op: "session.delete.daemon_dispose", session_id: sessionId, runtime_id: runtimeId, err },
          "daemon dispose forward failed",
        );
      }
    },
    resolveFileIds: async ({ tenantId, blocks }) => {
      const bucket = services.filesBlob;
      if (!bucket) return { blocks, mountFileIds: [] };
      const out: ContentBlock[] = [];
      const mountFileIds: string[] = [];
      for (const block of blocks) {
        if (
          (block.type === "document" || block.type === "image") &&
          block.source?.type === "file" &&
          block.source.file_id
        ) {
          const fileId = block.source.file_id;
          const meta = await services.files.get({ tenantId, fileId });
          const obj = meta ? await bucket.get(meta.r2_key) : null;
          if (!meta || !obj) throw new Error(`file_id ${fileId} not found`);
          const buf = await obj.arrayBuffer();
          const data = bytesToBase64(new Uint8Array(buf));
          out.push({
            ...block,
            source: {
              type: "base64",
              media_type: block.source.media_type || meta.media_type,
              data,
            },
          } as ContentBlock);
          mountFileIds.push(fileId);
          continue;
        }
        out.push(block);
      }
      return { blocks: out, mountFileIds };
    },
    cloneSessionFile: async ({ tenantId, sessionId, sourceFileId }) => {
      const src = await services.files.get({ tenantId, fileId: sourceFileId });
      if (!src) return null;
      const scopedFileId = generateFileId();
      const scopedR2Key = fileR2Key(tenantId, scopedFileId);
      const bucket = services.filesBlob;
      if (bucket) {
        const obj = await bucket.get(src.r2_key);
        if (obj) {
          await bucket.put(scopedR2Key, obj.body, {
            httpMetadata: { contentType: src.media_type },
          });
        }
      }
      await services.files.create({
        id: scopedFileId,
        tenantId,
        sessionId,
        filename: src.filename,
        mediaType: src.media_type,
        sizeBytes: src.size_bytes,
        r2Key: scopedR2Key,
        downloadable: src.downloadable,
      });
      return {
        fileId: scopedFileId,
        filename: src.filename,
        mediaType: src.media_type,
        sizeBytes: src.size_bytes,
      };
    },
    cascadeDeleteFiles: async ({ tenantId, sessionId }) => {
      // 1. Per-session secret KV cleanup
      await services.sessionSecrets.deleteAllForSession({ tenantId, sessionId });
      // 2. file_metadata + R2 blobs (orphan files belonging to session)
      try {
        const orphans = await services.files.deleteBySession({ sessionId });
        const bucket = services.filesBlob;
        if (bucket && orphans.length) {
          await Promise.all(
            orphans.map((f) =>
              bucket.delete(f.r2_key).catch((err) => {
                logWarn(
                  { op: "session.delete.r2_cleanup", session_id: sessionId, tenant_id: tenantId, r2_key: f.r2_key, err },
                  "orphan R2 file delete failed",
                );
              }),
            ),
          );
        }
      } catch (err) {
        logWarn(
          { op: "session.delete.metadata_cleanup", session_id: sessionId, tenant_id: tenantId, err },
          "metadata cleanup failed; session row already removed",
        );
      }
      // 3. R2 outputs prefix cascade
      if (env.FILES_BUCKET) {
        const prefix = sessionOutputsPrefix(tenantId, sessionId);
        let cursor: string | undefined;
        try {
          do {
            const list: R2Objects = await env.FILES_BUCKET.list({
              prefix,
              cursor,
              limit: 1000,
            });
            if (list.objects.length) {
              await Promise.all(
                list.objects.map((o: R2Object) =>
                  env.FILES_BUCKET!.delete(o.key).catch(() => undefined),
                ),
              );
            }
            cursor = list.truncated ? list.cursor : undefined;
          } while (cursor);
        } catch (err) {
          logWarn(
            { op: "session.delete.outputs_cleanup_list", session_id: sessionId, tenant_id: tenantId, err },
            "outputs prefix list failed",
          );
        }
      }
    },
    promoteSandboxFile: async ({ tenantId, sessionId, sandboxPath, filename, mediaType, downloadable, bytes }) => {
      const bucket = services.filesBlob;
      if (!bucket) throw new Error("FILES_BUCKET binding not configured");
      const newFileId = generateFileId();
      const r2Key = fileR2Key(tenantId, newFileId);
      await bucket.put(r2Key, bytes, { httpMetadata: { contentType: mediaType } });
      const row = await services.files.create({
        id: newFileId,
        tenantId,
        sessionId,
        filename,
        mediaType,
        sizeBytes: bytes.byteLength,
        r2Key,
        downloadable,
      });
      void sandboxPath;
      return toFileRecord(row);
    },
  };
}

/** R2-backed outputs adapter (CF-side companion of the Node FS adapter). */
export function cfOutputsAdapter(env: Env) {
  return {
    async list(tenantId: string, sessionId: string) {
      if (!env.FILES_BUCKET) return null;
      const prefix = sessionOutputsPrefix(tenantId, sessionId);
      const list = await env.FILES_BUCKET.list({ prefix, limit: 1000 });
      return list.objects.map((o: R2Object) => {
        const filename = o.key.slice(prefix.length);
        return {
          filename,
          size_bytes: o.size,
          uploaded_at: o.uploaded.toISOString(),
          media_type: o.httpMetadata?.contentType || guessOutputMime(filename),
        };
      });
    },
    async read(tenantId: string, sessionId: string, filename: string) {
      if (!env.FILES_BUCKET) return null;
      const r2Key = `${sessionOutputsPrefix(tenantId, sessionId)}${filename}`;
      const obj = await env.FILES_BUCKET.get(r2Key);
      if (!obj) return null;
      return {
        body: obj.body,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType || guessOutputMime(filename),
      };
    },
    async deleteAll() {
      // No-op — cascadeDeleteFiles already handles outputs cleanup.
    },
  };
}

function guessOutputMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
    csv: "text/csv", json: "application/json", html: "text/html",
  };
  return map[ext] || "application/octet-stream";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(bin);
}

// ── Provider-credential refresh ──────────────────────────────────────────
//
// Mirrors refreshProviderCredentialsForSession + tryGitHubBindingFastPath
// in the legacy apps/main/src/routes/sessions.ts. Signatures match what
// the package factory passes back as `lifecycle.*`.

async function refreshProviderCredentialsForSession(
  env: Env,
  services: Services,
  tenantId: string,
  agentId: string,
  vaultIds: string[],
): Promise<SessionEvent[]> {
  if (!vaultIds.length) return [];
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET) return [];
  if (!env.AUTH_DB) return [];
  const userRow = await env.AUTH_DB
    .prepare(`SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`)
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = userRow?.id ?? null;
  if (!userId) return [];
  const tagged = await services.credentials.listProviderTagged({
    tenantId,
    vaultIds,
  });
  if (!tagged.length) return [];
  const targets = new Map<string, { provider: "github" | "linear"; vaultId: string }>();
  for (const cred of tagged) {
    const provider = cred.auth.provider;
    if (provider !== "github" && provider !== "linear") continue;
    const key = `${provider}:${cred.vault_id}`;
    if (!targets.has(key)) targets.set(key, { provider, vaultId: cred.vault_id });
  }
  const failures: Array<{
    provider: "github" | "linear";
    vaultId: string;
    error: string;
    httpStatus?: number;
  }> = [];
  await Promise.all(
    Array.from(targets.values()).map(async ({ provider, vaultId }) => {
      try {
        const res = await env.INTEGRATIONS!.fetch(
          `http://gateway/${provider}/internal/refresh-by-vault`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET!,
            },
            body: JSON.stringify({ userId, vaultId }),
          },
        );
        if (!res.ok) {
          let bodyText: string | undefined;
          try {
            bodyText = (await res.text()).slice(0, 200);
          } catch {
            /* ignore */
          }
          failures.push({
            provider,
            vaultId,
            httpStatus: res.status,
            error: `gateway returned ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
          });
        }
      } catch (err) {
        failures.push({
          provider,
          vaultId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  void agentId;
  if (!failures.length) return [];
  return failures.map((f) => ({
    type: "session.warning",
    source: "credential_refresh",
    message: `${f.provider} credential refresh failed for vault ${f.vaultId} — tools using this credential may 401 mid-task and trigger an on-401 retry. ${f.error}`,
    details: {
      provider: f.provider,
      vault_id: f.vaultId,
      http_status: f.httpStatus,
      error: f.error,
    },
  })) as unknown as SessionEvent[];
}

async function tryGitHubBindingFastPath(
  env: Env,
  tenantId: string,
  repoUrl: string,
): Promise<{ token: string; vaultId: string } | null> {
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET || !env.AUTH_DB) return null;
  const org = parseGitHubOrg(repoUrl);
  if (!org) return null;
  const userRow = await env.AUTH_DB
    .prepare(`SELECT id FROM "user" WHERE tenantId = ? LIMIT 1`)
    .bind(tenantId)
    .first<{ id: string }>();
  const userId = userRow?.id;
  if (!userId) return null;
  const row = await env.AUTH_DB
    .prepare(
      `SELECT id, vault_id FROM linear_installations
         WHERE user_id = ? AND provider_id = 'github'
           AND lower(workspace_name) = lower(?)
           AND revoked_at IS NULL AND vault_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, org)
    .first<{ id: string; vault_id: string }>();
  if (!row?.vault_id) return null;
  try {
    const res = await env.INTEGRATIONS.fetch(
      `http://gateway/github/internal/refresh-by-vault`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET,
        },
        body: JSON.stringify({ userId, vaultId: row.vault_id }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    if (!data.token) return null;
    return { token: data.token, vaultId: row.vault_id };
  } catch (err) {
    recordEvent(env.ANALYTICS, {
      op: "session.start.github_fastpath.failed",
      ...errFields(err),
    });
    return null;
  }
}

function parseGitHubOrg(repoUrl: string): string | null {
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    return parts[0] || null;
  } catch {
    const ssh = repoUrl.match(/^git@github\.com:([^/]+)\//);
    if (ssh) return ssh[1];
    const bare = repoUrl.match(/^([^/]+)\/[^/]+$/);
    if (bare) return bare[1];
    return null;
  }
}

/** Vault credential bundling (services.credentials read by vault id). */
export async function fetchVaultCredentials(
  services: Services,
  tenantId: string,
  vaultIds: string[],
): Promise<Array<{ vault_id: string; credentials: CredentialConfig[] }>> {
  if (!vaultIds.length) return [];
  const grouped = await services.credentials.listByVaults({ tenantId, vaultIds });
  return grouped.map((g) => ({
    vault_id: g.vault_id,
    credentials: g.credentials as unknown as CredentialConfig[],
  }));
}

// Pure helper kept for test/unit/credential-refresh-warnings.test.ts —
// extracted so the unit test doesn't have to mock the integrations
// gateway, just the result struct.
export interface CredentialRefreshResult {
  attempted: number;
  succeeded: number;
  failures: Array<{
    provider: "github" | "linear";
    vaultId: string;
    error: string;
    httpStatus?: number;
  }>;
  skippedReason?:
    | "no_integrations_binding"
    | "no_auth_db"
    | "no_user_for_tenant"
    | "no_provider_credentials";
}

export function refreshResultToInitEvents(
  result: CredentialRefreshResult,
  ctx: { sessionId: string; tenantId: string },
): SessionEvent[] {
  if (result.skippedReason) {
    logWarn(
      {
        op: "session.start.credential_refresh.skipped",
        session_id: ctx.sessionId,
        tenant_id: ctx.tenantId,
        reason: result.skippedReason,
      },
      "credential refresh skipped",
    );
    return [];
  }
  if (!result.failures.length) return [];
  logWarn(
    {
      op: "session.start.credential_refresh",
      session_id: ctx.sessionId,
      tenant_id: ctx.tenantId,
      failed: result.failures.length,
      attempted: result.attempted,
      failures: result.failures,
    },
    "credential refresh had failures; tools using these creds may 401 mid-task",
  );
  return result.failures.map((f) => ({
    type: "session.warning",
    source: "credential_refresh",
    message: `${f.provider} credential refresh failed for vault ${f.vaultId} — tools using this credential may 401 mid-task and trigger an on-401 retry. ${f.error}`,
    details: {
      provider: f.provider,
      vault_id: f.vaultId,
      http_status: f.httpStatus,
      error: f.error,
    },
  })) as unknown as SessionEvent[];
}

export const __test__ = { refreshResultToInitEvents };
