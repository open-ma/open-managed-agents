import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { Session } from "@open-managed-agents/managed-agents-application";

import { NodeManagedSessionInputPreparer } from "../src/lib/node-managed-session-inputs.js";
import * as nodeManagedInputs from "../src/lib/node-managed-session-inputs.js";

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
  it("describes mounted custom skills for inclusion in the model system prompt", () => {
    const buildReminders = (nodeManagedInputs as Record<string, unknown>)
      .buildNodeManagedSkillReminders as undefined | ((session: Session) => Array<{
        source: string;
        text: string;
      }>);
    expect(buildReminders).toBeTypeOf("function");
    if (buildReminders === undefined) return;

    expect(buildReminders(managedSession())).toEqual([{
      source: "skill:skill_inputs",
      text: "Custom skill skill_inputs is mounted at /workspace/.openma/skills/skill_inputs/latest/. Locate and read its SKILL.md before applying it.",
    }]);
  });

  it("materializes file, pinned repository revision, and custom skill before execution", async () => {
    const writeFileBytes = vi.fn(async () => "written");
    const gitCheckout = vi.fn(async () => undefined);
    const exec = vi.fn(async () => "");
    const sandbox = {
      writeFileBytes,
      gitCheckout,
      exec,
      readFile: vi.fn(async () => { throw new Error("missing"); }),
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
      registerCommandSecrets: vi.fn(),
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
    const repositoryCredentials = {
      findGithubToken: vi.fn(async () => "ghp_private"),
    };
    const preparer = new NodeManagedSessionInputPreparer({
      files,
      skillVersions,
      repositoryCredentials,
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });

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
    expect(repositoryCredentials.findGithubToken).toHaveBeenCalledWith({
      workspaceId: "workspace_inputs",
      sessionId: "session_inputs_01",
      resourceId: "resource_repo_01",
    });
    expect(sandbox.registerCommandSecrets).toHaveBeenCalledWith("git", {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.http://git.example.test/repository.git.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3ByaXZhdGU=",
    });
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

  it("mounts durable outputs and memory stores before materializing inputs", async () => {
    const order: string[] = [];
    const session = managedSession();
    session.resources.push({
      type: "memory_store",
      memoryStoreId: "memory_01",
      name: "project-memory",
      access: "read_only",
      mountPath: "/mnt/memory/project-memory",
    });
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: async () => { order.push("outputs"); },
      mountMemoryStore: async () => { order.push("memory-mount"); },
      writeFileBytes: async () => { order.push("file-or-skill"); return "written"; },
      gitCheckout: async () => { order.push("repository"); },
      exec: async () => "",
      readFile: async () => { throw new Error("missing"); },
      registerCommandSecrets: () => undefined,
    } as unknown as SandboxExecutor;
    const preparer = new NodeManagedSessionInputPreparer({
      files: {
        downloadFile: async () => ({
          type: "found" as const,
          file: { content: bytes("FILE_INPUT_OK"), mimeType: "text/plain" },
        }),
      },
      skillVersions: {
        listSkillVersions: async () => ({
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
        }),
        downloadSkillVersion: async () => ({
          type: "found" as const,
          file: {
            content: zipSync({ "certification-skill/SKILL.md": bytes("SKILL_INPUT_OK") }),
            mimeType: "application/zip",
          },
        }),
      },
      repositoryCredentials: { findGithubToken: async () => "ghp_private" },
      memorySnapshots: {
        materialize: async () => {
          order.push("memory-snapshot");
          return { mountStoreId: "managed-snapshot/memory_01/revision" };
        },
      },
    });

    await preparer.prepare({ workspaceId: "workspace_inputs", session, sandbox });

    expect(order.slice(0, 3)).toEqual(["outputs", "memory-snapshot", "memory-mount"]);
  });

  it("validates a retained repository before preserving its working tree", async () => {
    const session = managedSession();
    session.agent.skills = [];
    session.resources = [session.resources[1]!];
    const exec = vi.fn(async (command: string) => {
      if (command.includes("remote get-url origin")) {
        return "http://git.example.test/repository.git";
      }
      return "";
    });
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
      readFile: vi.fn(async () => "ref: refs/heads/main"),
      exec,
      gitCheckout: vi.fn(async () => undefined),
      registerCommandSecrets: vi.fn(),
    } as unknown as SandboxExecutor;
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => "ghp_private" },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });

    await preparer.prepare({ workspaceId: "workspace_inputs", session, sandbox });

    expect(exec).toHaveBeenCalledWith(
      "git -C 'repository' remote get-url origin",
      30_000,
    );
    expect(exec).toHaveBeenCalledWith(
      "git -C 'repository' cat-file -e 'abcdef0123456789^{commit}'",
      30_000,
    );
    expect(sandbox.gitCheckout).not.toHaveBeenCalled();
  });

  it("fails closed when retained repository identity does not match the Session resource", async () => {
    const session = managedSession();
    session.agent.skills = [];
    session.resources = [session.resources[1]!];
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
      readFile: vi.fn(async () => "ref: refs/heads/main"),
      exec: vi.fn(async () => "http://git.example.test/another-repository.git"),
      registerCommandSecrets: vi.fn(),
    } as unknown as SandboxExecutor;
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => "ghp_private" },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox,
    })).rejects.toThrow(/retained repository.*does not match/i);
  });

  it("fails closed when the selected sandbox cannot mount durable outputs", async () => {
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => null },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session: { ...managedSession(), resources: [], agent: { ...managedSession().agent, skills: [] } },
      sandbox: {} as SandboxExecutor,
    })).rejects.toThrow(/durable session outputs/i);
  });

  it("does not require binary writes for provider-owned built-in skills", async () => {
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => null },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });
    const session = managedSession();
    session.resources = [];
    session.agent.skills = [{ type: "anthropic", skillId: "pdf" }];

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox: {
        sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
        mountSessionOutputs: async () => undefined,
      } as unknown as SandboxExecutor,
    })).resolves.toBeUndefined();
  });

  it("fails closed when a memory store is attached to a sandbox without memory mounts", async () => {
    const session = managedSession();
    session.agent.skills = [];
    session.resources = [{
      type: "memory_store",
      memoryStoreId: "memory_01",
      name: "project-memory",
      access: "read_write",
    }];
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => null },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: async () => undefined,
    } as unknown as SandboxExecutor;

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox,
    })).rejects.toThrow(/memory store mounts/i);
  });

  it("fails closed before snapshotting read-write Managed Memory", async () => {
    const session = managedSession();
    session.agent.skills = [];
    session.resources = [{
      type: "memory_store",
      memoryStoreId: "memory_01",
      name: "project-memory",
      access: "read_write",
    }];
    const materialize = vi.fn(async () => ({ mountStoreId: "unused" }));
    const mountMemoryStore = vi.fn(async () => undefined);
    const preparer = new NodeManagedSessionInputPreparer({
      files: { downloadFile: async () => { throw new Error("unexpected file download"); } },
      skillVersions: {
        listSkillVersions: async () => { throw new Error("unexpected skill listing"); },
        downloadSkillVersion: async () => { throw new Error("unexpected skill download"); },
      },
      repositoryCredentials: { findGithubToken: async () => null },
      memorySnapshots: { materialize },
    });
    const sandbox = {
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: async () => undefined,
      mountMemoryStore,
    } as unknown as SandboxExecutor;

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox,
    })).rejects.toThrow(/does not support read-write Memory Store/i);
    expect(materialize).not.toHaveBeenCalled();
    expect(mountMemoryStore).not.toHaveBeenCalled();
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
      repositoryCredentials: { findGithubToken: async () => null },
      memorySnapshots: { materialize: async () => ({ mountStoreId: "unused" }) },
    });
    const session = managedSession();
    session.resources = [];
    const sandbox = {
      writeFileBytes: vi.fn(async () => "written"),
      readFile: vi.fn(async () => ""),
      exec: vi.fn(async () => ""),
      sessionOutputMountCapabilities: () => ({ durability: "durable" as const }),
      mountSessionOutputs: vi.fn(async () => undefined),
    } as unknown as SandboxExecutor;

    await expect(preparer.prepare({
      workspaceId: "workspace_inputs",
      session,
      sandbox,
    })).rejects.toThrow(/unsafe skill archive path/i);
  });
});
