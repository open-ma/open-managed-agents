import { describe, expect, it } from "vitest";

import type { SandboxPort } from "../src/ports";
import {
  DefaultSandboxOrchestrator,
  type WorkspaceBackupService,
} from "../src/orchestrator";

const backups: WorkspaceBackupService = {
  snapshot: async () => null,
  restore: async () => ({ ok: true }),
  latest: async () => null,
};

function sandbox(extra: Record<string, unknown> = {}): SandboxPort {
  return {
    exec: async () => "",
    readFile: async () => "",
    writeFile: async (path: string) => path,
    ...extra,
  } as SandboxPort;
}

describe("SandboxOrchestrator persistence boundaries", () => {
  it("does not advertise a native workspace backup from a half-implemented Port", () => {
    const orchestrator = new DefaultSandboxOrchestrator({ backups });

    expect(orchestrator.capabilities(sandbox({
      createWorkspaceBackup: async () => null,
    })).hasWorkspaceBackup).toBe(false);
    expect(orchestrator.capabilities(sandbox({
      createWorkspaceBackup: async () => null,
      restoreWorkspaceBackup: async () => ({ ok: true }),
    })).hasWorkspaceBackup).toBe(true);
  });
});
