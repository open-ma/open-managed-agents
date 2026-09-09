import { describe, expect, it, vi } from "vitest";

import { resolveManagedSkillArchive } from "../src/lib/managed-skill-source";

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
