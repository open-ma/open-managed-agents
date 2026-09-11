import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { LocalSubprocessSandbox } from "../src/adapters/local-subprocess";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("LocalSubprocessSandbox git checkout", () => {
  it("maps a logical /workspace target into the sandbox workdir", async () => {
    const root = await mkdtemp(join(tmpdir(), "openma-local-git-"));
    roots.push(root);
    const source = join(root, "source");
    const workdir = join(root, "sandbox");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "OpenMA Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "test@openma.local"]);
    await writeFile(join(source, "marker.txt"), "REPO_INPUT_OK\n");
    await execFileAsync("git", ["-C", source, "add", "marker.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
    const sandbox = new LocalSubprocessSandbox({ workdir });

    await sandbox.gitCheckout(source, {
      branch: "main",
      targetDir: "/workspace/repository",
    });

    await expect(readFile(join(workdir, "repository", "marker.txt"), "utf8"))
      .resolves.toBe("REPO_INPUT_OK\n");
    await expect(readFile("/workspace/repository/marker.txt", "utf8"))
      .rejects.toThrow();
  });
});
