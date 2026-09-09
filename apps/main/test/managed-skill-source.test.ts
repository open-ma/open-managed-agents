import { describe, expect, it, vi } from "vitest";

import { resolveManagedSkillArchive } from "../src/lib/managed-skill-source";
import {
  downloadManagedSessionInputFile,
  resolveManagedSessionInputs,
  withMissingManagedSessionSchemaFallback,
} from "../src/lib/managed-session-runtime-source";

describe("Managed Skill worker source", () => {
  it("resolves latest through the application Port before downloading", async () => {
    const archive = new Uint8Array([1, 2, 3]);
    const versions = {
      listSkillVersions: vi.fn(async () => ({
        type: "page" as const,
        page: {
          versions: [{ version: "42", name: "repository-guide" }],
          nextCursor: null,
        },
      })),
      retrieveSkillVersion: vi.fn(async () => ({ type: "not_found" as const })),
      downloadSkillVersion: vi.fn(async () => ({
        type: "found" as const,
        file: { content: archive, mimeType: "application/zip" },
      })),
    };

    await expect(resolveManagedSkillArchive(
      versions,
      { skillId: "skill-1", requestedVersion: "latest" },
    )).resolves.toEqual({
      type: "found",
      version: "42",
      name: "repository-guide",
      archive,
    });
    expect(versions.listSkillVersions).toHaveBeenCalledWith({
      skillId: "skill-1",
      pageSize: 1,
    });
    expect(versions.downloadSkillVersion).toHaveBeenCalledWith({
      skillId: "skill-1",
      version: "42",
    });
  });
});

describe("Managed Session runtime source", () => {
  const session = {
    id: "session-1",
    environmentId: "environment-1",
    metadata: { lane: "certification" },
    archivedAt: null,
    resources: [
      {
        id: "resource-file",
        type: "file" as const,
        fileId: "file-1",
        mountPath: "/workspace/inputs/attached.txt",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "resource-repository",
        type: "github_repository" as const,
        url: "https://github.com/openma/private-certification.git",
        mountPath: "/workspace/repository",
        checkout: { type: "commit" as const, sha: "0123456789abcdef" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "memory_store" as const,
        memoryStoreId: "memory-1",
        name: "certification",
        mountPath: "/mnt/memory/certification",
        access: "read_only" as const,
      },
    ],
  };

  it("projects the current canonical Session resources for a runtime", async () => {
    const source = { find: vi.fn(async () => session) };

    await expect(resolveManagedSessionInputs(source, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
    })).resolves.toEqual({
      type: "found",
      session: {
        id: "session-1",
        environmentId: "environment-1",
        metadata: { lane: "certification" },
        resources: session.resources,
      },
    });
  });

  it("downloads only files attached to that current Session", async () => {
    const source = { find: vi.fn(async () => session) };
    const files = {
      downloadFile: vi.fn(async () => ({
        type: "found" as const,
        file: {
          content: new TextEncoder().encode("FILE_INPUT_OK"),
          filename: "attached.txt",
          mimeType: "text/plain",
        },
      })),
    };

    await expect(downloadManagedSessionInputFile(source, files, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      fileId: "file-1",
    })).resolves.toEqual(expect.objectContaining({ type: "found" }));
    await expect(downloadManagedSessionInputFile(source, files, {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      fileId: "file-not-attached",
    })).resolves.toEqual({ type: "not_found" });
    expect(files.downloadFile).toHaveBeenCalledTimes(1);
  });

  it("uses the migration fallback only when the canonical Session table is absent", async () => {
    const fallback = vi.fn(async () => ({ type: "legacy" as const }));

    await expect(withMissingManagedSessionSchemaFallback(
      async () => {
        throw new Error("D1_ERROR: no such table: managed_sessions: SQLITE_ERROR");
      },
      fallback,
    )).resolves.toEqual({ type: "legacy" });
    expect(fallback).toHaveBeenCalledTimes(1);

    await expect(withMissingManagedSessionSchemaFallback(
      async () => {
        throw new Error("D1_ERROR: database is locked");
      },
      fallback,
    )).rejects.toThrow("database is locked");
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
