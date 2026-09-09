import { lstat, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

const roots: string[] = [];
const rootLinks: string[] = [];

afterEach(async () => {
  await Promise.all(rootLinks.splice(0).map((path) =>
    unlink(path).catch(() => undefined)
  ));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("LocalSubprocessSandbox memory mounts", () => {
  it("enforces a read-only sandbox view without changing backing-store permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-local-memory-"));
    roots.push(root);
    const memoryRoot = join(root, "memory");
    const source = join(memoryRoot, "snapshot", "notes");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "input.txt"), "MEMORY_INPUT_OK", "utf8");
    const sandbox = new LocalSubprocessSandbox({
      workdir: join(root, "sandbox"),
      memoryRoot,
    });

    await sandbox.mountMemoryStore({
      storeName: "certification",
      storeId: "snapshot",
      readOnly: true,
    });

    await expect(sandbox.readFile("/mnt/memory/certification/notes/input.txt"))
      .resolves.toBe("MEMORY_INPUT_OK");
    await expect(sandbox.writeFile(
      "/mnt/memory/certification/notes/blocked.txt",
      "no",
    )).rejects.toThrow("mounted read-only");
    await expect(sandbox.exec(
      'printf mutation > "$OMA_MEMORY_CERTIFICATION/notes/input.txt"',
    )).resolves.toContain("[exit exit=1]");

    await writeFile(join(source, "collector-can-write.txt"), "yes", "utf8");
    await expect(readFile(join(source, "collector-can-write.txt"), "utf8"))
      .resolves.toBe("yes");
    await sandbox.destroy();
  });

  it("does not create process-global /mnt symlinks by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-local-memory-"));
    roots.push(root);
    const storeName = `openma-test-${crypto.randomUUID()}`;
    const rootLink = `/mnt/memory/${storeName}`;
    rootLinks.push(rootLink);
    const sandbox = new LocalSubprocessSandbox({
      workdir: join(root, "sandbox"),
      memoryRoot: join(root, "memory"),
    });

    await sandbox.mountMemoryStore({
      storeName,
      storeId: "snapshot",
      readOnly: false,
    });

    await expect(lstat(rootLink)).rejects.toMatchObject({ code: "ENOENT" });
    await sandbox.destroy();
  });

  it("cleans explicitly configured exclusive root mounts on destroy", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-local-memory-"));
    roots.push(root);
    const rootMountBase = join(root, "root-mnt");
    const sandbox = new LocalSubprocessSandbox({
      workdir: join(root, "sandbox"),
      memoryRoot: join(root, "memory"),
      rootMountBase,
    });
    const rootLink = join(rootMountBase, "memory", "certification");

    await sandbox.mountMemoryStore({
      storeName: "certification",
      storeId: "snapshot",
      readOnly: false,
    });

    await expect(lstat(rootLink)).resolves.toMatchObject({});
    await sandbox.destroy();
    await expect(lstat(rootLink)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to replace a pre-existing root mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-local-memory-"));
    roots.push(root);
    const rootMountBase = join(root, "root-mnt");
    const rootLink = join(rootMountBase, "memory", "certification");
    await mkdir(rootLink, { recursive: true });
    await writeFile(join(rootLink, "owner.txt"), "someone-else", "utf8");
    const sandbox = new LocalSubprocessSandbox({
      workdir: join(root, "sandbox"),
      memoryRoot: join(root, "memory"),
      rootMountBase,
    });

    await expect(sandbox.mountMemoryStore({
      storeName: "certification",
      storeId: "snapshot",
      readOnly: false,
    })).rejects.toThrow("root mount collision");
    await expect(readFile(join(rootLink, "owner.txt"), "utf8"))
      .resolves.toBe("someone-else");
    await sandbox.destroy();
  });
});
