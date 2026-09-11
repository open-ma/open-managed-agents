import type {
  ManagedSandboxPort,
  RuntimeOrphanPort,
} from "@open-managed-agents/runtime-resource-contract";

export interface ManagedRuntimeOrphanReconciler {
  runOnce(input: { limit: number }): Promise<{
    inspected: number;
    resolved: number;
    remaining: number;
  }>;
}

export function createManagedRuntimeOrphanReconciler(dependencies: {
  orphans: RuntimeOrphanPort;
  sandbox: ManagedSandboxPort;
}): ManagedRuntimeOrphanReconciler {
  return {
    async runOnce({ limit }) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new Error("Runtime orphan reconcile limit must be a positive integer");
      }
      const pending = await dependencies.orphans.list({ limit });
      let resolved = 0;
      for (const orphan of pending) {
        try {
          await dependencies.sandbox.reap({
            scope: orphan.scope,
            lease: orphan.sandbox,
            reason: orphan.reason,
          });
          await dependencies.orphans.resolve({ id: orphan.id });
          resolved += 1;
        } catch (error) {
          await dependencies.orphans.failed({ id: orphan.id, error });
        }
      }
      return {
        inspected: pending.length,
        resolved,
        remaining: pending.length - resolved,
      };
    },
  };
}
