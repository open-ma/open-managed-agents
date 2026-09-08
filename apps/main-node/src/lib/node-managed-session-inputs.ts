import { posix } from "node:path";
import { unzipSync } from "fflate";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type {
  FilesApplicationPort,
  Session,
  SkillVersionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";

type FileSource = Pick<FilesApplicationPort, "downloadFile">;
type SkillVersionSource = Pick<
  SkillVersionsApplicationPort,
  "downloadSkillVersion" | "listSkillVersions"
>;

export interface PrepareNodeManagedSessionInputs {
  workspaceId: string;
  session: Session;
  sandbox: SandboxExecutor;
}

export interface NodeManagedSessionInputPreparerDependencies {
  files: FileSource;
  skillVersions: SkillVersionSource;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellWorkspacePath(value: string): string {
  if (value === "/workspace") return ".";
  return value.startsWith("/workspace/")
    ? value.slice("/workspace/".length)
    : value;
}

function assertCommandSucceeded(command: string, output: string): void {
  if (/\[(?:error:|exit (?!exit=0\]))/u.test(output)) {
    throw new Error(`${command} failed: ${output}`);
  }
}

function safeArchivePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    value.includes("\0")
    || normalized === "."
    || normalized.startsWith("/")
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`Unsafe skill archive path: ${value}`);
  }
  return normalized;
}

/** Materializes the immutable inputs needed by the in-process Node harness.
 * This is deliberately an injected adapter: the runner owns ordering while
 * Files/Skills storage and sandbox I/O stay behind their existing ports. */
export class NodeManagedSessionInputPreparer {
  constructor(
    private readonly dependencies: NodeManagedSessionInputPreparerDependencies,
  ) {}

  async prepare(input: PrepareNodeManagedSessionInputs): Promise<void> {
    void input.workspaceId;
    const writeFileBytes = input.sandbox.writeFileBytes;
    const needsBinaryWrites = input.session.resources.some(
      (resource) => resource.type === "file",
    ) || input.session.agent.skills.length > 0;
    if (needsBinaryWrites && writeFileBytes === undefined) {
      throw new Error("Managed Session inputs require sandbox binary file writes");
    }

    for (const resource of input.session.resources) {
      if (resource.type === "file") {
        const downloaded = await this.dependencies.files.downloadFile({
          fileId: resource.fileId,
        });
        if (downloaded.type !== "found") {
          throw new Error(`Managed Session file ${resource.fileId} was not found`);
        }
        await writeFileBytes!.call(
          input.sandbox,
          resource.mountPath,
          downloaded.file.content,
        );
        continue;
      }
      if (resource.type === "github_repository") {
        await this.materializeRepository(input.sandbox, resource);
      }
    }

    for (const skill of input.session.agent.skills) {
      if (skill.type !== "custom") continue;
      const requestedVersion = skill.version ?? "latest";
      let concreteVersion = requestedVersion;
      if (requestedVersion === "latest") {
        const listed = await this.dependencies.skillVersions.listSkillVersions({
          skillId: skill.skillId,
          pageSize: 1,
        });
        if (listed.type !== "page" || listed.page.versions.length === 0) {
          throw new Error(`Managed Skill ${skill.skillId} has no version`);
        }
        concreteVersion = listed.page.versions[0]!.version;
      }
      const downloaded = await this.dependencies.skillVersions.downloadSkillVersion({
        skillId: skill.skillId,
        version: concreteVersion,
      });
      if (downloaded.type !== "found") {
        throw new Error(`Managed Skill ${skill.skillId}@${concreteVersion} was not found`);
      }
      const archive = unzipSync(downloaded.file.content);
      let foundManifest = false;
      for (const [rawPath, content] of Object.entries(archive)) {
        if (rawPath.endsWith("/")) continue;
        const path = safeArchivePath(rawPath);
        if (posix.basename(path) === "SKILL.md") foundManifest = true;
        await writeFileBytes!.call(
          input.sandbox,
          `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/${path}`,
          content,
        );
      }
      if (!foundManifest) {
        throw new Error(
          `Managed Skill ${skill.skillId}@${concreteVersion} archive has no SKILL.md`,
        );
      }
    }
  }

  private async materializeRepository(
    sandbox: SandboxExecutor,
    resource: Extract<Session["resources"][number], { type: "github_repository" }>,
  ): Promise<void> {
    // A restarted Node process can reopen a retained workspace. Preserve its
    // edits instead of destructively cloning over the repository again.
    try {
      await sandbox.readFile(`${resource.mountPath}/.git/HEAD`);
      return;
    } catch {
      // First acquisition: clone below.
    }

    if (sandbox.gitCheckout !== undefined) {
      await sandbox.gitCheckout(resource.url, {
        targetDir: resource.mountPath,
        ...(resource.checkout?.type === "branch"
          ? { branch: resource.checkout.name }
          : {}),
      });
    } else {
      const branch = resource.checkout?.type === "branch"
        ? `--branch ${shellQuote(resource.checkout.name)} `
        : "";
      const command = `git clone ${branch}-- ${shellQuote(resource.url)} ${shellQuote(shellWorkspacePath(resource.mountPath))}`;
      const output = await sandbox.exec(command, 120_000);
      assertCommandSucceeded(command, output);
    }
    if (resource.checkout?.type === "commit") {
      const command = `git -C ${shellQuote(shellWorkspacePath(resource.mountPath))} checkout --detach ${shellQuote(resource.checkout.sha)}`;
      const output = await sandbox.exec(command, 60_000);
      assertCommandSucceeded(command, output);
    }
  }
}
