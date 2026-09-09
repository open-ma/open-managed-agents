import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import {
  getSkillFilesFromManagedSource,
  getSkillFiles,
  skillFileMountPaths,
  resolveCustomSkills,
} from "../../apps/agent/src/harness/skills";
import {
  loadManagedSessionResources,
  mountResources,
} from "../../apps/agent/src/runtime/resource-mounter";
import type { SandboxExecutor } from "../../apps/agent/src/harness/interface";
import { fileR2Key, skillFileR2Key } from "@open-managed-agents/shared";

function objectBody(bytes: Uint8Array) {
  return {
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
  };
}

describe("in-sandbox Session resource wiring", () => {
  it("loads the current resource snapshot and scopes file access to the Session", async () => {
    const source = {
      resolveManagedSessionInputs: vi.fn(async () => ({
        type: "found" as const,
        session: {
          id: "session-1",
          environmentId: "environment-1",
          metadata: {},
          resources: [{ type: "file", fileId: "file-1", mountPath: "/workspace/input" }],
        },
      })),
      downloadManagedSessionFile: vi.fn(async () => ({
        type: "found" as const,
        content: new Uint8Array([1, 2, 3]),
        mimeType: "application/octet-stream",
      })),
    };

    const loaded = await loadManagedSessionResources(source, {
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    expect(loaded.resources).toEqual([
      { type: "file", fileId: "file-1", mountPath: "/workspace/input" },
    ]);
    await expect(loaded.fileSource.downloadFile("file-1")).resolves.toEqual({
      content: new Uint8Array([1, 2, 3]),
    });
    expect(source.downloadManagedSessionFile).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      fileId: "file-1",
    });
  });

  it("resolves canonical Memory content to a sandbox-mountable snapshot prefix", async () => {
    const materializeManagedMemorySnapshot = vi.fn(async () => ({
      type: "found" as const,
      mountStoreId: ".openma-managed-memory-snapshots/tenant-1/memory-1/digest",
    }));
    const source = {
      resolveManagedSessionInputs: vi.fn(async () => ({
        type: "found" as const,
        session: {
          id: "session-1",
          environmentId: "environment-1",
          metadata: {},
          resources: [{
            type: "memory_store",
            memoryStoreId: "memory-1",
            name: "certification",
            access: "read_only",
          }],
        },
      })),
      downloadManagedSessionFile: vi.fn(),
      materializeManagedMemorySnapshot,
    };

    const loaded = await loadManagedSessionResources(source, {
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    expect(materializeManagedMemorySnapshot).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
      memoryStoreId: "memory-1",
      access: "read_only",
    });
    expect(loaded.resources).toEqual([{
      type: "memory_store",
      memoryStoreId: "memory-1",
      name: "certification",
      access: "read_only",
      runtimeMountStoreId:
        ".openma-managed-memory-snapshots/tenant-1/memory-1/digest",
    }]);

    const sandbox = {
      exec: vi.fn(),
      mountMemoryStore: vi.fn(),
      setEnvVars: vi.fn(),
    };
    await mountResources(
      sandbox as unknown as SandboxExecutor,
      loaded.resources,
      {} as KVNamespace,
      new Map(),
    );
    expect(sandbox.mountMemoryStore).toHaveBeenCalledWith({
      storeId: ".openma-managed-memory-snapshots/tenant-1/memory-1/digest",
      storeName: "certification",
      readOnly: true,
    });
  });

  it.each([
    {
      name: "a File without object storage",
      resource: { id: "resource-file", type: "file", file_id: "file-1" },
      sandbox: { exec: vi.fn(), writeFileBytes: vi.fn() },
      expected: /file.*FILES_BUCKET/i,
    },
    {
      name: "a Memory Store without a mount Port",
      resource: {
        id: "resource-memory",
        type: "memory_store",
        memory_store_id: "memory-1",
      },
      sandbox: { exec: vi.fn() },
      expected: /memory.*mount/i,
    },
    {
      name: "an env resource without its sealed value",
      resource: { id: "resource-env", type: "env", name: "SERVICE_TOKEN" },
      sandbox: { exec: vi.fn(), setEnvVars: vi.fn() },
      expected: /env.*secret/i,
    },
    {
      name: "an unknown resource type",
      resource: { id: "resource-unknown", type: "secret_volume" },
      sandbox: { exec: vi.fn() },
      expected: /unsupported Session resource type/i,
    },
    {
      name: "a repository with an invalid branch ref",
      resource: {
        id: "resource-repository",
        type: "github_repository",
        url: "https://github.com/openma/example.git",
        checkout: { type: "branch", name: "-c core.sshCommand=unsafe" },
      },
      sandbox: { exec: vi.fn(), gitCheckout: vi.fn() },
      expected: /invalid Git branch/i,
    },
    {
      name: "a repository with an empty URL",
      resource: {
        id: "resource-repository",
        type: "github_repository",
        url: "",
      },
      sandbox: { exec: vi.fn(), gitCheckout: vi.fn() },
      expected: /requires a URL/i,
    },
    {
      name: "a repository with a non-SHA commit",
      resource: {
        id: "resource-repository",
        type: "github_repository",
        url: "https://github.com/openma/example.git",
        checkout: { type: "commit", sha: "main; echo unsafe" },
      },
      sandbox: { exec: vi.fn(), gitCheckout: vi.fn() },
      expected: /invalid Git commit SHA/i,
    },
  ])("fails closed before side effects for $name", async ({
    resource,
    sandbox,
    expected,
  }) => {
    await expect(mountResources(
      sandbox as unknown as SandboxExecutor,
      [resource],
      {} as KVNamespace,
      new Map(),
    )).rejects.toThrow(expected);
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("materializes binary files, named memory stores, and secret env values", async () => {
    const fileBytes = new Uint8Array([0, 255, 1, 2]);
    const bucket = {
      get: vi.fn(async (key: string) =>
        key === fileR2Key("tenant-1", "file-1") ? objectBody(fileBytes) : null),
    };
    const sandbox = {
      exec: vi.fn(async () => "MISSING"),
      writeFile: vi.fn(),
      writeFileBytes: vi.fn(),
      mountMemoryStore: vi.fn(),
      setEnvVars: vi.fn(),
    };

    await mountResources(
      sandbox as unknown as SandboxExecutor,
      [
        { id: "resource-file", type: "file", file_id: "file-1" },
        {
          id: "resource-memory",
          type: "memory_store",
          memory_store_id: "memory-1",
          access: "read_only",
        },
        { id: "resource-env", type: "env", name: "SERVICE_TOKEN" },
      ],
      {} as KVNamespace,
      new Map([["resource-env", "secret-value"]]),
      bucket as unknown as R2Bucket,
      "tenant-1",
      async (storeId) => storeId === "memory-1" ? { name: "Project memory" } : null,
    );

    expect(bucket.get).toHaveBeenCalledWith(fileR2Key("tenant-1", "file-1"));
    expect(sandbox.writeFileBytes).toHaveBeenCalledWith(
      "/mnt/session/uploads/file-1",
      fileBytes,
    );
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(sandbox.mountMemoryStore).toHaveBeenCalledWith({
      storeId: "memory-1",
      storeName: "Project memory",
      readOnly: true,
    });
    expect(sandbox.setEnvVars).toHaveBeenCalledWith({
      OMA_MEMORY_DIR: "/mnt/memory",
      OMA_MEMORY_PROJECT_MEMORY: "/mnt/memory/Project memory",
    });
    expect(sandbox.setEnvVars).toHaveBeenCalledWith({ SERVICE_TOKEN: "secret-value" });
  });

  it("materializes canonical Managed Session resources through the injected file Port", async () => {
    const fileBytes = new TextEncoder().encode("FILE_INPUT_OK");
    const downloadFile = vi.fn(async () => ({ content: fileBytes }));
    const sandbox = {
      exec: vi.fn(async () => "OK"),
      writeFileBytes: vi.fn(),
      mountMemoryStore: vi.fn(),
      setEnvVars: vi.fn(),
    };

    await mountResources(
      sandbox as unknown as SandboxExecutor,
      [
        {
          id: "resource-file",
          type: "file",
          fileId: "file-1",
          mountPath: "/workspace/inputs/attached.txt",
        },
        {
          type: "memory_store",
          memoryStoreId: "memory-1",
          name: "certification",
          mountPath: "/mnt/memory/certification",
          access: "read_only",
        },
      ],
      {} as KVNamespace,
      new Map(),
      undefined,
      "tenant-1",
      undefined,
      { downloadFile },
    );

    expect(downloadFile).toHaveBeenCalledWith("file-1");
    expect(sandbox.writeFileBytes).toHaveBeenCalledWith(
      "/workspace/inputs/attached.txt",
      fileBytes,
    );
    expect(sandbox.mountMemoryStore).toHaveBeenCalledWith({
      storeId: "memory-1",
      storeName: "certification",
      readOnly: true,
    });
    expect(sandbox.setEnvVars).toHaveBeenCalledWith({
      OMA_MEMORY_DIR: "/mnt/memory",
      OMA_MEMORY_CERTIFICATION: "/mnt/memory/certification",
    });
  });

  it("rejects an empty canonical File id before asking the control plane to download it", async () => {
    const downloadFile = vi.fn(async () => ({ content: new Uint8Array() }));
    const sandbox = {
      exec: vi.fn(),
      writeFileBytes: vi.fn(),
    };

    await expect(mountResources(
      sandbox as unknown as SandboxExecutor,
      [{ id: "resource-file", type: "file", fileId: "" }],
      {} as KVNamespace,
      new Map(),
      undefined,
      "tenant-1",
      undefined,
      { downloadFile },
    )).rejects.toThrow(/requires file_id/i);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("fails closed when a Memory Store name cannot be resolved", async () => {
    const mountMemoryStore = vi.fn();

    await expect(mountResources(
      { exec: vi.fn(), mountMemoryStore } as unknown as SandboxExecutor,
      [{
        id: "resource-memory",
        type: "memory_store",
        memory_store_id: "memory-1",
      }],
      {} as KVNamespace,
      new Map(),
      undefined,
      "tenant-1",
      async () => null,
    )).rejects.toThrow(/Memory Store memory-1.*not found/i);

    expect(mountMemoryStore).not.toHaveBeenCalled();
  });

  it("resolves latest custom skill metadata and mounts every skill file byte-for-byte", async () => {
    const skillId = "skill-1";
    const version = "1759178010641129";
    const markdown = new TextEncoder().encode("# Repository guide\nUse rg first.\n");
    const binary = new Uint8Array([0, 1, 254, 255]);
    const kvValues = new Map([
      [`t:tenant-1:skill:${skillId}`, JSON.stringify({
        id: skillId,
        name: "repository-guide",
        display_title: "Repository Guide",
        description: "Repository workflow",
        latest_version: version,
      })],
      [`t:tenant-1:skillver:${skillId}:${version}`, JSON.stringify({
        files: [
          { filename: "SKILL.md", encoding: "utf8" },
          { filename: "assets/logo.bin", encoding: "base64" },
        ],
      })],
    ]);
    const objectValues = new Map([
      [skillFileR2Key("tenant-1", skillId, version, "SKILL.md"), markdown],
      [skillFileR2Key("tenant-1", skillId, version, "assets/logo.bin"), binary],
    ]);
    const kv = { get: vi.fn(async (key: string) => kvValues.get(key) ?? null) };
    const bucket = {
      get: vi.fn(async (key: string) => {
        const bytes = objectValues.get(key);
        return bytes === undefined ? null : objectBody(bytes);
      }),
    };
    const declaration = [{ type: "custom", skill_id: skillId, version: "latest" }] as const;

    const promptSkills = await resolveCustomSkills(
      [...declaration],
      kv as unknown as KVNamespace,
      bucket as unknown as R2Bucket,
      "tenant-1",
    );
    const mountedSkills = await getSkillFiles(
      [...declaration],
      kv as unknown as KVNamespace,
      bucket as unknown as R2Bucket,
      "tenant-1",
    );

    expect(promptSkills).toEqual([expect.objectContaining({
      id: skillId,
      name: "Repository Guide",
      system_prompt_addition: expect.stringContaining("Use rg first."),
    })]);
    expect(mountedSkills).toEqual([{
      skillId,
      skillName: "repository-guide",
      requestedVersion: "latest",
      files: [
        { filename: "SKILL.md", bytes: markdown },
        { filename: "assets/logo.bin", bytes: binary },
      ],
    }]);
    expect(skillFileMountPaths(mountedSkills[0]!, "assets/logo.bin")).toEqual([
      "/workspace/.openma/skills/skill-1/latest/assets/logo.bin",
      "/home/user/.skills/repository-guide/assets/logo.bin",
    ]);
    expect(bucket.get).toHaveBeenCalledWith(
      skillFileR2Key("tenant-1", skillId, version, "SKILL.md"),
    );
    expect(bucket.get).toHaveBeenCalledWith(
      skillFileR2Key("tenant-1", skillId, version, "assets/logo.bin"),
    );
  });

  it.each([
    "../outside",
    "nested/../../outside",
    "/absolute/path",
    "nul\0byte",
  ])("rejects unsafe custom Skill archive path %s", (filename) => {
    expect(() => skillFileMountPaths({
      skillId: "skill-1",
      skillName: "repository-guide",
      requestedVersion: "latest",
      files: [],
    }, filename)).toThrow(/unsafe skill archive path/i);
  });

  it("fails closed when a declared custom Skill object is missing", async () => {
    const skillId = "skill-missing-object";
    const version = "1";
    const kvValues = new Map([
      [`t:tenant-1:skill:${skillId}`, JSON.stringify({
        id: skillId,
        name: "missing-object",
        latest_version: version,
      })],
      [`t:tenant-1:skillver:${skillId}:${version}`, JSON.stringify({
        files: [{ filename: "SKILL.md" }],
      })],
    ]);
    const kv = { get: vi.fn(async (key: string) => kvValues.get(key) ?? null) };
    const bucket = { get: vi.fn(async () => null) };

    await expect(getSkillFiles(
      [{ type: "custom", skill_id: skillId, version: "latest" }],
      kv as unknown as KVNamespace,
      bucket as unknown as R2Bucket,
      "tenant-1",
    )).rejects.toThrow(/skill-missing-object.*SKILL\.md.*not found/i);
  });

  it("materializes a custom Skill archive from the main control-plane Port", async () => {
    const archive = zipSync({
      "repository-guide/SKILL.md": new TextEncoder().encode("SKILL_INPUT_OK"),
      "repository-guide/assets/logo.bin": new Uint8Array([0, 255]),
    });
    const resolveManagedSkillVersion = vi.fn(async () => ({
      type: "found" as const,
      version: "42",
      name: "repository-guide",
      archive,
    }));

    const files = await getSkillFilesFromManagedSource(
      [{ type: "custom", skill_id: "skill-1", version: "latest" }],
      { resolveManagedSkillVersion },
    );

    expect(resolveManagedSkillVersion).toHaveBeenCalledWith({
      skillId: "skill-1",
      requestedVersion: "latest",
    });
    expect(files).toEqual([{
      skillId: "skill-1",
      skillName: "repository-guide",
      requestedVersion: "latest",
      files: [
        expect.objectContaining({ filename: "repository-guide/SKILL.md" }),
        expect.objectContaining({ filename: "repository-guide/assets/logo.bin" }),
      ],
    }]);
  });

  it("clones a repository into its declared mount path without persisting its credential", async () => {
    const exec = vi.fn(async (command: string) =>
      command.startsWith("which gh ") ? "OK" : "");
    const gitCheckout = vi.fn(async () => undefined);
    const sandbox = { exec, gitCheckout };

    await mountResources(
      sandbox as unknown as SandboxExecutor,
      [{
        id: "resource-repository",
        type: "github_repository",
        url: "https://github.com/openma/example.git",
        mount_path: "/workspace/example",
        checkout: { type: "branch", name: "feature/resource-wiring" },
      }],
      {} as KVNamespace,
      new Map([["resource-repository", "github-token-must-not-enter-sandbox"]]),
    );

    expect(gitCheckout).toHaveBeenCalledWith(
      "https://github.com/openma/example.git",
      { targetDir: "/workspace/example" },
    );
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      expect.stringContaining("credential.helper"),
      expect.stringContaining("git config user.name"),
      expect.stringContaining("git fetch origin 'feature/resource-wiring:refs/remotes/origin/feature/resource-wiring'"),
      expect.stringContaining("which gh"),
    ]);
    expect(JSON.stringify(exec.mock.calls)).not.toContain("github-token-must-not-enter-sandbox");
  });

  it("shell-quotes repository paths used by post-clone commands", async () => {
    const exec = vi.fn(async (command: string) =>
      command.startsWith("which gh ") ? "OK" : "");
    const gitCheckout = vi.fn(async () => undefined);
    const mountPath = "/workspace/repo name; echo unsafe";

    await mountResources(
      { exec, gitCheckout } as unknown as SandboxExecutor,
      [{
        id: "resource-repository",
        type: "github_repository",
        url: "https://github.com/openma/example.git",
        mount_path: mountPath,
        checkout: { type: "commit", sha: "0123456789abcdef" },
      }],
      {} as KVNamespace,
      new Map(),
    );

    expect(gitCheckout).toHaveBeenCalledWith(
      "https://github.com/openma/example.git",
      { targetDir: mountPath },
    );
    const commands = exec.mock.calls.map(([command]) => command);
    expect(commands).toContain(
      "cd '/workspace/repo name; echo unsafe' && git config user.name \"Agent\" && git config user.email \"agent@managed-agents.dev\"",
    );
    expect(commands).toContain(
      "cd '/workspace/repo name; echo unsafe' && git checkout '0123456789abcdef'",
    );
  });

  it("fails the mount when a required repository preparation command fails", async () => {
    const exec = vi.fn(async () => "exit=1\nstderr: permission denied");
    const gitCheckout = vi.fn(async () => undefined);

    await expect(mountResources(
      { exec, gitCheckout } as unknown as SandboxExecutor,
      [{
        id: "resource-repository",
        type: "github_repository",
        url: "https://github.com/openma/example.git",
        mount_path: "/workspace/example",
      }],
      {} as KVNamespace,
      new Map(),
    )).rejects.toThrow(/repository command failed[\s\S]*permission denied/i);

    expect(gitCheckout).not.toHaveBeenCalled();
  });
});
