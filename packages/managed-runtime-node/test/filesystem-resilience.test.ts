import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyFileOnce,
  directoryManifest,
  rethrowUnlessAlreadyExists,
  rooted,
  safeLogicalPath,
  safeMetadataPath,
  writeOnce,
} from "../src/filesystem";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oma-node-filesystem-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("node filesystem safety primitives", () => {
  it("classifies exclusive publication conflicts without swallowing other failures", () => {
    expect(() => rethrowUnlessAlreadyExists({ code: "EEXIST" })).not.toThrow();
    const error = Object.assign(new Error("disk failed"), { code: "EIO" });
    expect(() => rethrowUnlessAlreadyExists(error)).toThrow(error);
  });

  it("normalizes logical paths while rejecting absolute and parent traversal paths", () => {
    expect(safeLogicalPath("reports\\nested\\result.txt")).toBe("reports/nested/result.txt");
    for (const unsafe of [".", "/etc/passwd", "..", "../secret", "folder/../../secret"]) {
      expect(() => safeLogicalPath(unsafe)).toThrow(/unsafe output path/i);
    }
  });

  it("accepts only absolute metadata paths and keeps resolved paths inside their root", async () => {
    const root = await temporaryRoot();
    expect(safeMetadataPath(root, "binding")).toBe(root);
    expect(() => safeMetadataPath(undefined, "binding")).toThrow(/absolute host path/i);
    expect(() => safeMetadataPath("relative", "binding")).toThrow(/absolute host path/i);
    expect(rooted(root)).toBe(root);
    expect(rooted(root, "inside", "file")).toBe(join(root, "inside", "file"));
    expect(() => rooted(root, "..", "outside")).toThrow(/escaped its storage root/i);
  });

  it("builds a deterministic manifest for directories, files, and symlinks", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "z-directory"));
    await writeFile(join(root, "z-directory", "child.txt"), "child");
    await writeFile(join(root, "a-file.txt"), "hello");
    await symlink("a-file.txt", join(root, "m-link"));

    await expect(directoryManifest(root)).resolves.toEqual({
      version: 1,
      entries: [
        expect.objectContaining({ path: "a-file.txt", type: "file", size: 5 }),
        { path: "m-link", type: "symlink", target: "a-file.txt" },
        { path: "z-directory", type: "directory" },
        expect.objectContaining({ path: "z-directory/child.txt", type: "file", size: 5 }),
      ],
    });
  });

  it("fails closed on special filesystem entries", async () => {
    const root = await temporaryRoot();
    const socket = join(root, "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      await expect(directoryManifest(root)).rejects.toThrow(/unsupported workspace entry/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("writes immutable files once and preserves the winning value", async () => {
    const root = await temporaryRoot();
    const target = join(root, "immutable", "value.txt");
    await writeOnce(target, "winner");
    await writeOnce(target, "loser");
    await expect(readFile(target, "utf8")).resolves.toBe("winner");
  });

  it("propagates write-once filesystem failures", async () => {
    const root = await temporaryRoot();
    const parentFile = join(root, "not-a-directory");
    await writeFile(parentFile, "file");
    await expect(writeOnce(join(parentFile, "child"), "value")).rejects.toBeDefined();
  });

  it("publishes copied files without replacing an existing immutable target", async () => {
    const root = await temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const target = join(root, "blobs", "value");
    await writeFile(first, "winner");
    await writeFile(second, "loser");

    await copyFileOnce(first, target);
    await copyFileOnce(second, target);

    await expect(readFile(target, "utf8")).resolves.toBe("winner");
    const leftovers = await Promise.all(
      [target].map(async (path) => (await lstat(path)).isFile()),
    );
    expect(leftovers).toEqual([true]);
  });

  it("removes partial copies when publication fails", async () => {
    const root = await temporaryRoot();
    const missing = join(root, "missing-source");
    const target = join(root, "blobs", "value");
    await expect(copyFileOnce(missing, target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not depend on target write permissions after an immutable value exists", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    await writeFile(source, "same");
    await writeFile(target, "stable");
    await chmod(target, 0o400);
    try {
      await copyFileOnce(source, target);
      await expect(readFile(target, "utf8")).resolves.toBe("stable");
    } finally {
      await chmod(target, 0o600);
    }
  });
});
