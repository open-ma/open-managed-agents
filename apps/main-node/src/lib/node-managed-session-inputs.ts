import { posix } from "node:path";
import { unzipSync } from "fflate";
import {
  supportsSessionOutputMount,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import type {
  FilesApplicationPort,
  Session,
  SkillVersionsApplicationPort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionResourceSecretSource } from "@open-managed-agents/session-resource-store";
import type { NodeManagedMemorySnapshotPort } from "./node-managed-memory-snapshots.js";

type FileSource = Pick<FilesApplicationPort, "downloadFile">;
type SkillVersionSource = Pick<
  SkillVersionsApplicationPort,
  "downloadSkillVersion" | "listSkillVersions"
>;

export interface PrepareNodeManagedSessionInputs {
  workspaceId: string;
  session: Session;
  sandbox: SandboxExecutor;
  /** Stable identifier for this concrete sandbox incarnation. Writable
   * Memory workspaces use it as an isolation/fencing boundary. */
  runtimeGeneration?: string;
}

export interface NodeManagedSessionInputPreparerDependencies {
  files: FileSource;
  skillVersions: SkillVersionSource;
  repositoryCredentials: Pick<SessionResourceSecretSource, "findGithubToken">;
  memorySnapshots: NodeManagedMemorySnapshotPort;
}

export function buildNodeManagedSkillReminders(
  session: Session,
): Array<{ source: string; text: string }> {
  return session.agent.skills.flatMap((skill) => {
    if (skill.type !== "custom") return [];
    const requestedVersion = skill.version ?? "latest";
    const mountRoot = `/workspace/.openma/skills/${encodeURIComponent(skill.skillId)}/${encodeURIComponent(requestedVersion)}/`;
    return [{
      source: `skill:${skill.skillId}`,
      text: `Custom skill ${skill.skillId} is mounted at ${mountRoot}. Locate and read its SKILL.md before applying it.`,
    }];
  });
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
  const prefixedExit = /^exit=(-?\d+)\n/u.exec(output);
  if (
    (prefixedExit !== null && Number(prefixedExit[1]) !== 0)
    || /\[(?:error:|exit (?!exit=0\]))/u.test(output)
  ) {
    throw new Error(`${command} failed: ${output}`);
  }
}

function commandStdout(command: string, output: string): string {
  assertCommandSucceeded(command, output);
  return output.replace(/^exit=0\n/u, "").trim();
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
    if (!supportsSessionOutputMount(input.sandbox)) {
      throw new Error(
        "Managed Session runtime requires durable session outputs, but the selected sandbox does not provide them",
      );
    }
    await input.sandbox.mountSessionOutputs({
      tenantId: input.workspaceId,
      sessionId: input.session.id,
    });
    await input.sandbox.setEnvVars?.({
      OMA_OUTPUTS_DIR: "/mnt/session/outputs",
    });

    const memoryStores = input.session.resources.filter(
      (resource) => resource.type === "memory_store",
    );
    if (memoryStores.length > 0 && input.sandbox.mountMemoryStore === undefined) {
      throw new Error(
        "Managed Session has memory stores, but the selected sandbox does not support memory store mounts",
      );
    }
    for (const resource of memoryStores) {
      const access = resource.access === "read_only" ? "read_only" : "read_write";
      if (
        access === "read_write" &&
        input.runtimeGeneration === undefined
      ) {
        throw new Error(
          `Writable Managed Memory Store ${resource.memoryStoreId} requires a runtime generation`,
        );
      }
      const snapshot = await this.dependencies.memorySnapshots.materialize({
        workspaceId: input.workspaceId,
        sessionId: input.session.id,
        memoryStoreId: resource.memoryStoreId,
        access,
        ...(access === "read_write"
          ? { runtimeGeneration: input.runtimeGeneration }
          : {}),
      });
      await input.sandbox.mountMemoryStore!({
        storeName: resource.name ?? resource.memoryStoreId,
        storeId: snapshot.mountStoreId,
        readOnly: access === "read_only",
      });
      const storeName = resource.name ?? resource.memoryStoreId;
      await input.sandbox.setEnvVars?.({
        OMA_MEMORY_DIR: "/mnt/memory",
        [`OMA_MEMORY_${storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]:
          `/mnt/memory/${storeName}`,
      });
    }

    const repositories = input.session.resources.filter(
      (resource) => resource.type === "github_repository",
    );
    if (repositories.length > 0) {
      if (input.sandbox.registerCommandSecrets === undefined) {
        throw new Error(
          "Managed Session has GitHub repositories, but the selected sandbox cannot scope repository credentials",
        );
      }
      const gitCredentialEnv: Record<string, string> = {
        GIT_CONFIG_COUNT: String(repositories.length),
      };
      for (const [index, resource] of repositories.entries()) {
        const token = await this.dependencies.repositoryCredentials.findGithubToken({
          workspaceId: input.workspaceId,
          sessionId: input.session.id,
          resourceId: resource.id,
        });
        if (token === null) {
          throw new Error(
            `Managed Session GitHub credential for resource ${resource.id} was not found`,
          );
        }
        gitCredentialEnv[`GIT_CONFIG_KEY_${index}`] =
          `http.${resource.url}.extraHeader`;
        gitCredentialEnv[`GIT_CONFIG_VALUE_${index}`] =
          `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
      }
      input.sandbox.registerCommandSecrets("git", gitCredentialEnv);
    }

    const writeFileBytes = input.sandbox.writeFileBytes;
    const needsBinaryWrites = input.session.resources.some(
      (resource) => resource.type === "file",
    ) || input.session.agent.skills.some((skill) => skill.type === "custom");
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
    let retained = true;
    try {
      await sandbox.readFile(`${resource.mountPath}/.git/HEAD`);
    } catch {
      retained = false;
    }
    if (!retained) return this.cloneRepository(sandbox, resource);

    const repositoryDir = shellQuote(shellWorkspacePath(resource.mountPath));
    const remoteCommand = `git -C ${repositoryDir} remote get-url origin`;
    const remote = commandStdout(
      remoteCommand,
      await sandbox.exec(remoteCommand, 30_000),
    );
    if (remote !== resource.url) {
      throw new Error(
        `Retained repository at ${resource.mountPath} does not match Session resource ${resource.id}: expected ${resource.url}, found ${remote || "no origin"}`,
      );
    }
    if (resource.checkout?.type === "commit") {
      const commitCommand = `git -C ${repositoryDir} cat-file -e ${shellQuote(`${resource.checkout.sha}^{commit}`)}`;
      commandStdout(
        commitCommand,
        await sandbox.exec(commitCommand, 30_000),
      );
    }
  }

  private async cloneRepository(
    sandbox: SandboxExecutor,
    resource: Extract<Session["resources"][number], { type: "github_repository" }>,
  ): Promise<void> {
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
