import type {
  SkillVersionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";

export type ManagedSkillArchiveResult =
  | {
      type: "found";
      version: string;
      name: string;
      archive: Uint8Array;
    }
  | { type: "not_found" };

export async function resolveManagedSkillArchive(
  versions: Pick<
    SkillVersionsApplicationPort,
    "listSkillVersions" | "retrieveSkillVersion" | "downloadSkillVersion"
  >,
  input: { skillId: string; requestedVersion: string },
): Promise<ManagedSkillArchiveResult> {
  const view = input.requestedVersion === "latest"
    ? await versions.listSkillVersions({ skillId: input.skillId, pageSize: 1 })
    : await versions.retrieveSkillVersion({
        skillId: input.skillId,
        version: input.requestedVersion,
      });
  const version = view.type === "page"
    ? view.page.versions[0]
    : view.type === "found"
      ? view.version
      : undefined;
  if (version === undefined) return { type: "not_found" };
  const downloaded = await versions.downloadSkillVersion({
    skillId: input.skillId,
    version: version.version,
  });
  if (downloaded.type !== "found") return { type: "not_found" };
  return {
    type: "found",
    version: version.version,
    name: version.name,
    archive: downloaded.file.content,
  };
}
