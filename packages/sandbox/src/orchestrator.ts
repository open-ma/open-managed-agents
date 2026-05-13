// SandboxOrchestrator — single entry point both runtimes use to provision
// a session sandbox + its environment (vault outbound, memory mounts,
// session outputs mount, optional workspace backup/restore).
//
// Replaces the per-runtime plumbing that used to live separately in
//   - apps/agent/src/oma-sandbox.ts (CF setOutboundContext / setBackupContext / snapshot)
//   - apps/main-node/src/registry.ts (Node mountMemoryStore / mountSessionOutputs / setOutboundContext)
// CF wiring constructs the orchestrator with `cfBindings`; Node wiring
// passes `nodeBindings`. Both call the same `provision(sessionId, ...)`.
//
// What stays per-provider: the SandboxExecutor adapter implementations
// (LocalSubprocess, LiteBox, Daytona, E2B, BoxRun, CloudflareSandbox) —
// the orchestrator never branches on provider. Capabilities are
// introspected via the `capabilities()` helper which fakes a minimal
// SandboxExecutor surface query (presence-of-method probe) so the
// orchestrator can refuse session creation when a tenant policy requires
// a feature the chosen provider doesn't support.

import type { SandboxExecutor } from "./ports";

export interface OrchestratorMemoryMount {
  storeName: string;
  storeId: string;
  readOnly: boolean;
}

export interface OrchestratorBackupHandle {
  /** Backup id — opaque to callers; format depends on provider. */
  id: string;
  /** Provider hint — CF uses the Sandbox SDK's directory ref shape. */
  dir?: string;
  localBucket?: boolean;
}

export interface SandboxCapabilities {
  /** Can mountMemoryStore({readOnly:true}) actually enforce read-only at OS level? */
  enforceReadOnlyMemory: boolean;
  /** Can mountSessionOutputs surface writes back through the host? */
  hasSessionOutputs: boolean;
  /** Can vault outbound (HTTPS_PROXY + CA) be installed? */
  hasVaultOutbound: boolean;
  /** Can the workspace be backed up + restored across sandbox lifetimes? */
  hasWorkspaceBackup: boolean;
}

export interface ProvisionInput {
  sessionId: string;
  tenantId: string;
  /** Optional environment id — only meaningful for CF backups (per-env scope). */
  environmentId?: string;
  /** Memory stores to bind into the sandbox at /mnt/memory/<storeName>/. */
  memoryMounts?: OrchestratorMemoryMount[];
  /** Mount /mnt/session/outputs/ scoped to (tenantId, sessionId). */
  mountOutputs?: boolean;
  /** Backup config — restore from latest, or skip when undefined. */
  backup?: {
    /** When true, attempt restore-from-latest before first exec. */
    restoreOnWarm: boolean;
    /** Optional pre-fetched backup handle to restore from. */
    handle?: OrchestratorBackupHandle | null;
  };
}

export interface SandboxOrchestrator {
  /** Per-provider capability matrix. Used by the routes layer to gate
   *  session creation when policy requires a feature. */
  capabilities(sandbox: SandboxExecutor): SandboxCapabilities;

  /** Wire vault outbound + memory + outputs + backup-restore on a fresh
   *  sandbox. Called once per session, before the first user.message
   *  reaches the harness. Throws on hard mount failures (e.g. the tenant
   *  required readOnly memory but the provider can't enforce). */
  provision(sandbox: SandboxExecutor, input: ProvisionInput): Promise<void>;

  /** Snapshot the workspace into BlobStore + record a row in
   *  workspace_backups. Best-effort — providers that don't support
   *  backup return null. */
  snapshotWorkspaceNow(sandbox: SandboxExecutor, input: {
    sessionId: string;
    tenantId: string;
  }): Promise<OrchestratorBackupHandle | null>;

  /** Tell a long-idle sandbox "I'm still active" — resets CF's
   *  sleepAfter timer. No-op for adapters that don't auto-sleep. */
  renewActivityTimeout(sandbox: SandboxExecutor): Promise<void>;
}

/**
 * Default orchestrator: does provider-agnostic plumbing only. Hosts
 * compose with provider-specific factories outside this package
 * (CF wires the OmaSandbox + R2 backup; Node wires the BlobStore-backed
 * tar backup via `workspaceBackupService`).
 */
export interface DefaultSandboxOrchestratorDeps {
  /** Optional workspace backup repo. When unset, `snapshotWorkspaceNow`
   *  returns null. Node wires this via NodeWorkspaceBackupService;
   *  CF wires `recordCfBackup`. */
  backups?: WorkspaceBackupService | null;
  /** Optional logger for orchestrator-level warnings. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export interface WorkspaceBackupService {
  /** Snapshot a sandbox's workspace into durable storage; return a
   *  handle the same provider can later restore from. Null = unsupported
   *  on this provider. */
  snapshot(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
  }): Promise<OrchestratorBackupHandle | null>;
  /** Restore a backup into a fresh sandbox's /workspace before the first
   *  exec. Returns ok=false if the backup is missing/expired/corrupt;
   *  callers treat that as "fresh /workspace, proceed". */
  restore(input: {
    sessionId: string;
    tenantId: string;
    sandbox: SandboxExecutor;
    handle: OrchestratorBackupHandle;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Latest backup row for a session — orchestrator's restore-on-warm
   *  uses this to skip the explicit handle plumbing. */
  latest(input: {
    sessionId: string;
    tenantId: string;
  }): Promise<OrchestratorBackupHandle | null>;
}

export class DefaultSandboxOrchestrator implements SandboxOrchestrator {
  constructor(private deps: DefaultSandboxOrchestratorDeps = {}) {}

  capabilities(sandbox: SandboxExecutor): SandboxCapabilities {
    // Presence-of-method probes mirror the SandboxExecutor port shape.
    // For "does this enforce readOnly at OS level" we have no
    // introspection — the answer is provider-specific docs (in
    // self-host.md the per-provider matrix). Default to "best effort"
    // so the orchestrator doesn't block normal flows.
    return {
      enforceReadOnlyMemory: typeof sandbox.mountMemoryStore === "function",
      hasSessionOutputs: typeof sandbox.mountSessionOutputs === "function",
      hasVaultOutbound: typeof sandbox.setOutboundContext === "function",
      hasWorkspaceBackup:
        this.deps.backups !== null &&
        this.deps.backups !== undefined &&
        (typeof sandbox.createWorkspaceBackup === "function" ||
          typeof sandbox.readFileBytes === "function"),
    };
  }

  async provision(sandbox: SandboxExecutor, input: ProvisionInput): Promise<void> {
    // 1. Vault outbound — set HTTPS_PROXY + upload CA before any exec.
    //    Provider's setOutboundContext is responsible for the no-op when
    //    the OMA_VAULT_* env vars are unset.
    if (sandbox.setOutboundContext) {
      try {
        await sandbox.setOutboundContext({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
        });
      } catch (err) {
        this.deps.logger?.warn(
          `[sandbox-orchestrator] setOutboundContext failed: ${(err as Error).message} — outbound TLS through oma-vault may not work`,
        );
      }
    }

    // 2. Backup context (CF only) + best-effort restore.
    if (input.environmentId && sandbox.setBackupContext) {
      await sandbox.setBackupContext({
        tenantId: input.tenantId,
        environmentId: input.environmentId,
        sessionId: input.sessionId,
      });
    }
    if (input.backup?.restoreOnWarm && this.deps.backups) {
      const handle =
        input.backup.handle ??
        (await this.deps.backups.latest({
          sessionId: input.sessionId,
          tenantId: input.tenantId,
        }));
      if (handle) {
        const r = await this.deps.backups.restore({
          sessionId: input.sessionId,
          tenantId: input.tenantId,
          sandbox,
          handle,
        });
        if (!r.ok) {
          this.deps.logger?.warn(
            `[sandbox-orchestrator] restore failed (${r.error ?? "unknown"}) — proceeding with empty workspace`,
          );
        }
      }
    }

    // 3. Mount memory stores.
    if (input.memoryMounts?.length && sandbox.mountMemoryStore) {
      for (const m of input.memoryMounts) {
        try {
          await sandbox.mountMemoryStore({
            storeName: m.storeName,
            storeId: m.storeId,
            readOnly: m.readOnly,
          });
        } catch (err) {
          // Mount-store errors are user-visible; surface them rather
          // than silently degrading.
          throw new Error(
            `mountMemoryStore ${m.storeName} failed: ${(err as Error).message}`,
          );
        }
      }
    }

    // 4. Mount session outputs.
    if (input.mountOutputs && sandbox.mountSessionOutputs) {
      try {
        await sandbox.mountSessionOutputs({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
        });
      } catch (err) {
        this.deps.logger?.warn(
          `[sandbox-orchestrator] mountSessionOutputs failed: ${(err as Error).message}`,
        );
      }
    }
  }

  async snapshotWorkspaceNow(
    sandbox: SandboxExecutor,
    input: { sessionId: string; tenantId: string },
  ): Promise<OrchestratorBackupHandle | null> {
    // Prefer the adapter's native snapshot when available (CF squashfs).
    if (sandbox.snapshotWorkspaceNow) {
      try {
        await sandbox.snapshotWorkspaceNow();
        // CF's snapshot writes the row from inside the OmaSandbox DO; we
        // don't get a handle back here — caller already has the row.
        return null;
      } catch (err) {
        this.deps.logger?.warn(
          `[sandbox-orchestrator] adapter snapshotWorkspaceNow failed: ${(err as Error).message}`,
        );
      }
    }
    if (this.deps.backups) {
      return this.deps.backups.snapshot({
        sessionId: input.sessionId,
        tenantId: input.tenantId,
        sandbox,
      });
    }
    return null;
  }

  async renewActivityTimeout(sandbox: SandboxExecutor): Promise<void> {
    if (sandbox.renewActivityTimeout) await sandbox.renewActivityTimeout();
  }
}
