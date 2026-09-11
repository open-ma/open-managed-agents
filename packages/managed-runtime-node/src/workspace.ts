import { cp } from "node:fs/promises";
import type {
  WorkspaceBinding,
  WorkspaceCheckpointCandidate,
  WorkspacePersistencePort,
} from "@open-managed-agents/runtime-resource-contract";

import {
  directoryManifest,
  mkdir,
  readFile,
  rename,
  rm,
  rooted,
  safeMetadataPath,
  scopeDirectory,
  sha256,
  stableJson,
  writeFile,
} from "./filesystem";

export interface NodeFilesystemWorkspaceOptions {
  rootDir: string;
}

export class NodeFilesystemWorkspacePort implements WorkspacePersistencePort {
  readonly #rootDir: string;

  constructor(options: NodeFilesystemWorkspaceOptions) {
    this.#rootDir = options.rootDir;
  }

  async capabilities() {
    return { strategies: ["checkpoint_restore"] as const };
  }

  async materialize(input: Parameters<WorkspacePersistencePort["materialize"]>[0]) {
    input.signal.throwIfAborted();
    if (input.strategy !== "checkpoint_restore") {
      throw new Error(`Node filesystem workspace does not support ${input.strategy}`);
    }
    const scope = scopeDirectory(input.scope);
    const bindingId = `wsb_${sha256(input.idempotencyKey).slice(0, 32)}`;
    const bindingRoot = rooted(
      this.#rootDir,
      "runtime",
      scope,
      String(input.fence.generation),
      bindingId,
    );
    const hostPath = rooted(bindingRoot, "workspace");
    await rm(bindingRoot, { recursive: true, force: true });
    await mkdir(bindingRoot, { recursive: true });

    if (input.activeCheckpoint !== null) {
      if (!/^wcp_[a-f0-9]{64}$/.test(input.activeCheckpoint.id)) {
        throw new Error("Invalid workspace checkpoint id");
      }
      const candidateRoot = rooted(
        this.#rootDir,
        "workspaces",
        scope,
        "candidates",
        input.activeCheckpoint.id,
      );
      const contentRoot = rooted(candidateRoot, "content");
      const manifest = await directoryManifest(contentRoot);
      const contentHash = `sha256:${sha256(stableJson(manifest))}`;
      if (contentHash !== input.activeCheckpoint.contentHash) {
        throw new Error("Workspace checkpoint content hash mismatch");
      }
      await cp(contentRoot, hostPath, {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
    } else {
      await mkdir(hostPath, { recursive: true });
    }
    input.signal.throwIfAborted();

    return {
      bindingId,
      mountPath: "/workspace",
      metadata: { hostPath, bindingRoot },
    } satisfies WorkspaceBinding;
  }

  async checkpoint(
    input: Parameters<WorkspacePersistencePort["checkpoint"]>[0],
  ): Promise<WorkspaceCheckpointCandidate> {
    input.signal.throwIfAborted();
    if (input.strategy !== "checkpoint_restore") {
      throw new Error(`Node filesystem workspace does not support ${input.strategy}`);
    }
    const source = safeMetadataPath(input.binding.metadata?.hostPath, "workspace binding");
    const manifest = await directoryManifest(source);
    const manifestJson = stableJson(manifest);
    const hash = sha256(manifestJson);
    const id = `wcp_${hash}`;
    const candidatesRoot = rooted(
      this.#rootDir,
      "workspaces",
      scopeDirectory(input.scope),
      "candidates",
    );
    const finalRoot = rooted(candidatesRoot, id);
    try {
      await readFile(rooted(finalRoot, "manifest.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const stageRoot = rooted(
        candidatesRoot,
        `.partial-${sha256(input.idempotencyKey).slice(0, 32)}-${process.pid}`,
      );
      await rm(stageRoot, { recursive: true, force: true });
      await mkdir(stageRoot, { recursive: true });
      await cp(source, rooted(stageRoot, "content"), {
        recursive: true,
        dereference: false,
      });
      await writeFile(rooted(stageRoot, "manifest.json"), manifestJson);
      try {
        await rename(stageRoot, finalRoot);
      } catch (renameError) {
        rethrowUnlessCheckpointPublicationConflict(renameError);
        await rm(stageRoot, { recursive: true, force: true });
      }
    }
    input.signal.throwIfAborted();
    return {
      id,
      contentHash: `sha256:${hash}`,
      revision: input.fence.generation,
    };
  }

  async attach(
    _input: Parameters<WorkspacePersistencePort["attach"]>[0],
  ): Promise<void> {
    // The Docker adapter bind-mounts the hostPath supplied by materialize.
    // No provider RPC is needed after container acquisition.
  }

  async release(input: Parameters<WorkspacePersistencePort["release"]>[0]): Promise<void> {
    const bindingRoot = safeMetadataPath(
      input.binding.metadata?.bindingRoot,
      "workspace binding root",
    );
    await rm(bindingRoot, { recursive: true, force: true });
  }
}

/** Normalize platform-specific results of racing immutable directory publishes. */
export function rethrowUnlessCheckpointPublicationConflict(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  // POSIX commonly reports ENOTEMPTY when two publishers race to install the
  // same non-empty directory; Windows may report EEXIST.
  if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
}
