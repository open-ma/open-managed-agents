import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  SessionOutputEntryCandidate,
  SessionOutputManifestCandidate,
  SessionOutputPort,
} from "@open-managed-agents/runtime-resource-contract";

import {
  copyFileOnce,
  mkdir,
  readFile,
  rm,
  rooted,
  safeLogicalPath,
  safeMetadataPath,
  scopeDirectory,
  sha256,
  stableJson,
  writeOnce,
} from "./filesystem";

export interface NodeFilesystemSessionOutputOptions {
  rootDir: string;
}

export class NodeFilesystemSessionOutputPort implements SessionOutputPort {
  readonly #rootDir: string;

  constructor(options: NodeFilesystemSessionOutputOptions) {
    this.#rootDir = options.rootDir;
  }

  async capabilities() {
    return {
      strategies: [{ strategy: "final_collect", durability: "durable" }] as const,
    };
  }

  async prepare(input: Parameters<SessionOutputPort["prepare"]>[0]) {
    input.signal.throwIfAborted();
    if (input.strategy !== "final_collect") {
      throw new Error(`Node filesystem outputs do not support ${input.strategy}`);
    }
    const bindingId = `outb_${sha256(input.idempotencyKey).slice(0, 32)}`;
    const bindingRoot = rooted(
      this.#rootDir,
      "runtime-outputs",
      scopeDirectory(input.scope),
      String(input.fence.generation),
      bindingId,
    );
    const hostPath = rooted(bindingRoot, "outputs");
    await rm(bindingRoot, { recursive: true, force: true });
    await mkdir(hostPath, { recursive: true });
    input.signal.throwIfAborted();
    return {
      bindingId,
      mountPath: "/mnt/session/outputs",
      metadata: { hostPath, bindingRoot },
    } as const;
  }

  async collect(
    input: Parameters<SessionOutputPort["collect"]>[0],
  ): Promise<readonly SessionOutputEntryCandidate[]> {
    input.signal.throwIfAborted();
    const root = safeMetadataPath(input.binding.metadata?.hostPath, "output binding");
    const entries: SessionOutputEntryCandidate[] = [];
    async function visit(directory: string): Promise<void> {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const absolute = join(directory, child.name);
        const stat = await lstat(absolute);
        if (stat.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!stat.isFile()) {
          throw new Error(`Session output must be a regular file: ${child.name}`);
        }
        const content = await readFile(absolute);
        input.signal.throwIfAborted();
        entries.push({
          logicalPath: safeLogicalPath(relative(root, absolute).split(sep).join("/")),
          contentHash: `sha256:${sha256(content)}`,
          size: content.byteLength,
        });
      }
    }
    await visit(root);
    input.signal.throwIfAborted();
    return entries;
  }

  async attach(
    _input: Parameters<SessionOutputPort["attach"]>[0],
  ): Promise<void> {
    // The Docker adapter bind-mounts the hostPath supplied by prepare.
  }

  async finalize(
    input: Parameters<SessionOutputPort["finalize"]>[0],
  ): Promise<SessionOutputManifestCandidate> {
    input.signal.throwIfAborted();
    const root = safeMetadataPath(input.binding.metadata?.hostPath, "output binding");
    const entries = [...input.entries].sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath),
    );
    for (const entry of entries) {
      const logicalPath = safeLogicalPath(entry.logicalPath);
      const source = rooted(root, ...logicalPath.split("/"));
      const content = await readFile(source);
      input.signal.throwIfAborted();
      const actualHash = `sha256:${sha256(content)}`;
      if (actualHash !== entry.contentHash || content.byteLength !== entry.size) {
        throw new Error(`Session output changed during collection: ${logicalPath}`);
      }
      await copyFileOnce(
        source,
        rooted(this.#rootDir, "outputs", "blobs", entry.contentHash.slice("sha256:".length)),
      );
      input.signal.throwIfAborted();
    }
    const manifest = {
      version: 1,
      sessionId: input.scope.sessionId,
      entries,
    } as const;
    const manifestJson = stableJson(manifest);
    const hash = sha256(manifestJson);
    await writeOnce(
      rooted(this.#rootDir, "outputs", "manifests", `${hash}.json`),
      manifestJson,
    );
    input.signal.throwIfAborted();
    return {
      id: `out_${hash}`,
      contentHash: `sha256:${hash}`,
      entries: entries.length,
    };
  }

  async abort(input: Parameters<SessionOutputPort["abort"]>[0]): Promise<void> {
    const bindingRoot = safeMetadataPath(
      input.binding.metadata?.bindingRoot,
      "output binding root",
    );
    await rm(bindingRoot, { recursive: true, force: true });
  }

  async release(input: Parameters<SessionOutputPort["release"]>[0]): Promise<void> {
    const bindingRoot = safeMetadataPath(
      input.binding.metadata?.bindingRoot,
      "output binding root",
    );
    await rm(bindingRoot, { recursive: true, force: true });
  }
}
