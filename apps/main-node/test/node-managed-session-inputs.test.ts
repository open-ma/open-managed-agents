import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { Session } from "@open-managed-agents/managed-agents-application";

import { NodeManagedSessionInputPreparer } from "../src/lib/node-managed-session-inputs.js";

const bytes = (value: string) => new TextEncoder().encode(value);

function managedSession(): Session {
  return {
    id: "session_inputs_01",
    agent: {
      id: "agent_inputs_01",
      description: null,
      mcpServers: [],
      model: { id: "model_inputs" },
      multiagent: null,
      name: "Input verifier",
      skills: [{ type: "custom", skillId: "skill_inputs", version: "latest" }],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    environmentId: "env_inputs_01",
    metadata: {},
    outcomeEvaluations: [],
    resources: [
      {
        id: "resource_file_01",
        type: "file",
        fileId: "file_inputs_01",
        mountPath: "/workspace/inputs/attached.txt",
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
      {
        id: "resource_repo_01",
        type: "github_repository",
        url: "http://git.example.test/repository.git",
        mountPath: "/workspace/repository",
        checkout: { type: "commit", sha: "abcdef0123456789" },
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    ],
    stats: {},
    status: "running",
    title: null,
    updatedAt: "2026-09-08T00:00:00.000Z",
    usage: {},
    vaultIds: [],
  };
}

describe("NodeManagedSessionInputPreparer", () => {
  it("materializes file, pinned repository revision, and custom skill before execution", async () => {
    const writeFileBytes = vi.fn(async () => "written");
    const gitCheckout = vi.fn(async () => undefined);
    const exec = vi.fn(async () => "");
    const sandbox = {
      writeFileBytes,
      gitCheckout,
      exec,
      readFile: vi.fn(async () => { throw new Error("missing"); }),
    } as unknown as SandboxExecutor;
    const files = {
      downloadFile: vi.fn(async () => ({
        type: "found" as const,
        file: {
          content: bytes("FILE_INPUT_OK"),
          filename: "attached.txt",
          mimeType: "text/plain",
        },
      })),
    };
    const skillArchive = zipSync({
      "certification-skill/SKILL.md": bytes(
        "---\nname: certification-skill\ndescription: Verify mounted inputs\n---\nSKILL_INPUT_OK\n",
      ),
      "certification-skill/reference.txt": bytes("REFERENCE_OK"),
    });
    const skillVersions = {
      listSkillVersions: vi.fn(async () => ({
        type: "page" as const,
        page: {
          versions: [{
            id: "skv_inputs_01",
            createdAt: "2026-09-08T00:00:00.000Z",
            description: "Verify mounted inputs",
            directory: "certification-skill",
            name: "certification-skill",
            skillId: "skill_inputs",
            version: "123",
          }],
          nextCursor: null,
        },
      })),
      downloadSkillVersion: vi.fn(async () => ({
        type: "found" as const,
        file: {
          content: skillArchive,
          filename: "certification-skill.zip",
          mimeType: "application/zip",
        },
      })),
    };
    const preparer = new NodeManagedSessionInputPreparer({ files, skillVersions });

    await preparer.prepare({
      workspaceId: "workspace_inputs",
      session: managedSession(),
      sandbox,
    });

    expect(files.downloadFile).toHaveBeenCalledWith({ fileId: "file_inputs_01" });
    expect(writeFileBytes).toHaveBeenCalledWith(
      "/workspace/inputs/attached.txt",
      bytes("FILE_INPUT_OK"),
    );
    expect(gitCheckout).toHaveBeenCalledWith(
      "http://git.example.test/repository.git",
      { targetDir: "/workspace/repository" },
    );
    expect(exec).toHaveBeenCalledWith(
      "git -C 'repository' checkout --detach 'abcdef0123456789'",
      60_000,
    );
    expect(skillVersions.listSkillVersions).toHaveBeenCalledWith({
      skillId: "skill_inputs",
      pageSize: 1,
    });
    expect(skillVersions.downloadSkillVersion).toHaveBeenCalledWith({
      skillId: "skill_inputs",
      version: "123",
    });
    expect(writeFileBytes).toHaveBeenCalledWith(
      "/workspace/.openma/skills/skill_inputs/latest/certification-skill/SKILL.md",
      expect.any(Uint8Array),
    );
    expect(writeFileBytes).toHaveBeenCalledWith(
      "/workspace/.openma/skills/skill_inputs/latest/certification-skill/reference.txt",
      expect.any(Uint8Array),
    );
  });

  it("fails closed when a skill archive contains a parent traversal", async () => {
    const preparer = new NodeManagedSessionInputPreparer({
      files: {
        downloadFile: vi.fn(async () => ({
          type: "found" as const,
          file: { content: bytes("FILE_INPUT_OK"), mimeType: "text/plain" },
        })),
      },
      skillVersions: {
        listSkillVersions: vi.fn(async () => ({
          type: "page" as const,
          page: {
            versions: [{
              id: "skv_inputs_01",
              createdAt: "2026-09-08T00:00:00.000Z",
              description: "unsafe",
              directory: "unsafe",
              name: "unsafe",
              skillId: "skill_inputs",
              version: "123",
            }],
            nextCursor: null,
          },
        })),
        downloadSkillVersion: vi.fn(async () => ({
          type: "found" as const,
          file: {
            content: zipSync({ "../SKILL.md": bytes("unsafe") }),
            filename: "unsafe.zip",
            mimeType: "application/zip",
          },
        })),
      },
    });
    const session = managedSession();
    session.resources = [];
    const sandbox = {
      writeFileBytes: vi.fn(async () => "written"),
      readFile: vi.fn(async () => ""),
      exec: vi.fn(async () => ""),
    } as unknown as SandboxExecutor;

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox,
    })).rejects.toThrow(/unsafe skill archive path/i);
  });
});
