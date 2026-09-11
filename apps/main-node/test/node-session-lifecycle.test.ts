import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeOutputsAdapter } from "../src/lib/node-outputs-adapter.js";
import { nodeSessionLifecycle } from "../src/lib/node-session-lifecycle.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }),
  ));
});

describe("Node managed session deletion cleanup", () => {
  it("removes the session output directory even when no file metadata exists", async () => {
    const outputsRoot = await mkdtemp(join(tmpdir(), "oma-session-outputs-"));
    temporaryRoots.push(outputsRoot);
    const outputDir = join(outputsRoot, "tenant_a", "session_same");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "report.txt"), "artifact");

    const hooks = nodeSessionLifecycle({
      files: { deleteBySession: async () => [] } as never,
      filesBlob: { delete: async () => {} } as never,
      outputs: nodeOutputsAdapter(outputsRoot),
    });

    await hooks.cascadeDeleteFiles?.({
      tenantId: "tenant_a",
      sessionId: "session_same",
    });

    await expect(access(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
