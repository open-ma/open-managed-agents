import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

interface ManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  hash?: string;
  size?: number;
  target?: string;
}

export interface DirectoryManifest {
  version: 1;
  entries: ManifestEntry[];
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function scopeDirectory(scope: {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
}): string {
  return sha256(
    [scope.workspaceId, scope.environmentId, scope.sessionId, scope.workId].join("\u0000"),
  );
}

export function safeMetadataPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.startsWith(sep)) {
    throw new Error(`${name} is missing an absolute host path`);
  }
  return value;
}

export function safeLogicalPath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe output path: ${value}`);
  }
  return normalized;
}

export async function directoryManifest(root: string): Promise<DirectoryManifest> {
  const entries: ManifestEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const logical = relative(root, absolute).split(sep).join("/");
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        entries.push({ path: logical, type: "directory" });
        await visit(absolute);
      } else if (stat.isFile()) {
        const content = await readFile(absolute);
        entries.push({
          path: logical,
          type: "file",
          hash: `sha256:${sha256(content)}`,
          size: content.byteLength,
        });
      } else if (stat.isSymbolicLink()) {
        entries.push({
          path: logical,
          type: "symlink",
          target: await readlink(absolute),
        });
      } else {
        throw new Error(`Unsupported workspace entry: ${logical}`);
      }
    }
  }

  await visit(root);
  return { version: 1, entries };
}

export async function writeOnce(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  } catch (error) {
    rethrowUnlessAlreadyExists(error);
  }
}

export async function copyFileOnce(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, temporary);
    try {
      // `rename()` replaces an existing file on POSIX, which violates the
      // content-addressed store's write-once contract. The temporary file is
      // created beside the target, so an atomic hard-link publication gives
      // us exclusive-create semantics without exposing a partial target.
      await link(temporary, target);
    } catch (error) {
      rethrowUnlessAlreadyExists(error);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Normalize the one benign result of an exclusive immutable publication. */
export function rethrowUnlessAlreadyExists(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}

export function rooted(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const result = resolve(base, ...parts);
  if (result !== base && !result.startsWith(`${base}${sep}`)) {
    throw new Error("Resolved path escaped its storage root");
  }
  return result;
}

export { mkdir, readFile, rename, rm, writeFile };
