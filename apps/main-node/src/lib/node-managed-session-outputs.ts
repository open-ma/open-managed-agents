import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import type {
  SandboxExecutor,
  SandboxSessionOutputMountPort,
} from "@open-managed-agents/sandbox";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

const OUTPUTS_DIR = "/mnt/session/outputs";
const MAX_OUTPUT_FILES = 10_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;

export interface SynchronizeNodeManagedSessionOutputs {
  workspaceId: string;
  sessionId: string;
  sandbox: SandboxExecutor;
  executionFence: SessionExecutionFence;
}

export interface NodeManagedSessionOutputCollectorDependencies {
  outputsRoot: string;
  isFenceActive(fence: SessionExecutionFence): Promise<boolean>;
}

function assertSafeId(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

function decodeOutputPaths(encoded: string): string[] {
  const value = encoded.trim();
  if (value === "") return [];
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("Sandbox returned an invalid Session output manifest");
  }
  return Buffer.from(value, "base64")
    .toString("utf8")
    .split("\0")
    .filter((path: string) => path !== "");
}

function logicalOutputPath(absolutePath: string): string {
  const normalized = posix.normalize(absolutePath);
  const prefix = `${OUTPUTS_DIR}/`;
  if (
    absolutePath.includes("\0")
    || normalized === OUTPUTS_DIR
    || !normalized.startsWith(prefix)
  ) {
    throw new Error(`Unsafe Session output path: ${absolutePath}`);
  }
  const logicalPath = normalized.slice(prefix.length);
  if (
    logicalPath === ""
    || logicalPath === "."
    || logicalPath === ".."
    || logicalPath.startsWith("../")
  ) {
    throw new Error(`Unsafe Session output path: ${absolutePath}`);
  }
  return logicalPath;
}

function assertInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot
    && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error(`Session output escaped its durable root: ${candidate}`);
  }
}

/**
 * Promotes provider-local Session outputs into the Node host's durable output
 * surface. Provider-native durable mounts remain zero-copy. The execution
 * fence is checked before reading and immediately before publishing the staged
 * snapshot, so an orphaned runtime cannot replace the canonical outputs.
 */
export class NodeManagedSessionOutputCollector {
  constructor(
    private readonly dependencies: NodeManagedSessionOutputCollectorDependencies,
  ) {}

  async synchronize(input: SynchronizeNodeManagedSessionOutputs): Promise<void> {
    const outputMount = input.sandbox as SandboxExecutor &
      Partial<SandboxSessionOutputMountPort>;
    const capabilities = typeof outputMount.sessionOutputMountCapabilities === "function"
      ? outputMount.sessionOutputMountCapabilities()
      : null;
    if (capabilities?.durability === "durable") return;
    if (capabilities?.durability !== "best_effort") {
      throw new Error("Sandbox does not expose collectable Session outputs");
    }
    if (input.sandbox.readFileBytes === undefined) {
      throw new Error("Sandbox cannot read provider-local Session outputs");
    }
    await this.assertFence(input.executionFence);

    assertSafeId("workspace id", input.workspaceId);
    assertSafeId("session id", input.sessionId);
    const workspaceRoot = join(this.dependencies.outputsRoot, input.workspaceId);
    await mkdir(workspaceRoot, { recursive: true });
    const staging = await mkdtemp(join(workspaceRoot, `.${input.sessionId}.collect-`));
    const target = join(workspaceRoot, input.sessionId);
    const previous = join(
      workspaceRoot,
      `.${input.sessionId}.previous-${input.executionFence.attemptId}`,
    );

    try {
      const encoded = await input.sandbox.exec(
        `find ${OUTPUTS_DIR} -type f -print0 | base64 | tr -d '\\n'`,
      );
      const absolutePaths = decodeOutputPaths(encoded);
      if (absolutePaths.length > MAX_OUTPUT_FILES) {
        throw new Error(`Session output file limit exceeded (${MAX_OUTPUT_FILES})`);
      }

      let totalBytes = 0;
      const seen = new Set<string>();
      for (const absolutePath of absolutePaths) {
        const logicalPath = logicalOutputPath(absolutePath);
        if (seen.has(logicalPath)) {
          throw new Error(`Duplicate Session output path: ${logicalPath}`);
        }
        seen.add(logicalPath);
        const bytes = await input.sandbox.readFileBytes(absolutePath);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          throw new Error(`Session output byte limit exceeded (${MAX_OUTPUT_BYTES})`);
        }
        const destination = join(staging, logicalPath);
        assertInside(staging, destination);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }

      await this.assertFence(input.executionFence);
      await rm(previous, { recursive: true, force: true });
      let movedPrevious = false;
      try {
        await rename(target, previous);
        movedPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, target);
      } catch (error) {
        if (movedPrevious) await rename(previous, target).catch(() => undefined);
        throw error;
      }
      if (movedPrevious) await rm(previous, { recursive: true, force: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async assertFence(fence: SessionExecutionFence): Promise<void> {
    if (!await this.dependencies.isFenceActive(fence)) {
      throw new Error("Managed Session output synchronization lost the execution fence");
    }
  }
}
