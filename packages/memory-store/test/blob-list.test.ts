import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsBlobStore } from "../src/adapters/local-fs-blob.js";
import { CfR2BlobStore } from "../src/adapters/cf-r2.js";
import { InMemoryBlobStore } from "../src/test-fakes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("BlobStore list", () => {
  it.each([
    ["in-memory", async () => new InMemoryBlobStore()],
    ["local filesystem", async () => {
      const root = await mkdtemp(join(tmpdir(), "openma-blob-list-"));
      temporaryDirectories.push(root);
      return new LocalFsBlobStore({ baseDir: root });
    }],
  ])("returns sorted logical keys below one prefix for %s", async (_name, build) => {
    const store = await build();
    await store.put("workspace/data/b.txt", "b");
    await store.put("other/data/ignored.txt", "ignored");
    await store.put("workspace/data/a.txt", "a");

    await expect(store.list("workspace/data/")).resolves.toEqual({
      keys: ["workspace/data/a.txt", "workspace/data/b.txt"],
      nextCursor: null,
    });
  });

  it("projects R2 list pages into logical keys and cursor", async () => {
    const list = async () => ({
      objects: [{ key: "workspace/data/a.txt" }, { key: "workspace/data/b.txt" }],
      truncated: true,
      cursor: "next-page",
    });
    const store = new CfR2BlobStore({ list } as unknown as R2Bucket);

    await expect(store.list("workspace/data/", "current-page")).resolves.toEqual({
      keys: ["workspace/data/a.txt", "workspace/data/b.txt"],
      nextCursor: "next-page",
    });
  });
});
