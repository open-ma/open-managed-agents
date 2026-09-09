import type { SandboxExecutor } from "../harness/interface";
import { fileR2Key } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

export interface ManagedSessionFileSource {
  downloadFile(fileId: string): Promise<{ content: Uint8Array }>;
}

export interface ManagedSessionResourceSource {
  resolveManagedSessionInputs(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<
    | {
        type: "found";
        session: {
          resources: readonly (Readonly<Record<string, unknown>> & { type: string })[];
        };
      }
    | { type: "not_found" }
  >;
  downloadManagedSessionFile(input: {
    tenantId: string;
    sessionId: string;
    fileId: string;
  }): Promise<
    | { type: "found"; content: Uint8Array }
    | { type: "not_found" }
  >;
  materializeManagedMemorySnapshot(input: {
    tenantId: string;
    sessionId: string;
    memoryStoreId: string;
    access: "read_only" | "read_write";
  }): Promise<
    | { type: "found"; mountStoreId: string }
    | { type: "not_found" }
  >;
}

export async function loadManagedSessionResources(
  source: ManagedSessionResourceSource,
  input: { tenantId: string; sessionId: string },
): Promise<{
  resources: Array<Record<string, unknown>>;
  fileSource: ManagedSessionFileSource;
}> {
  const resolved = await source.resolveManagedSessionInputs(input);
  if (resolved.type !== "found") {
    throw new Error(`Managed Session ${input.sessionId} was not found`);
  }
  const resources: Array<Record<string, unknown>> = [];
  for (const resource of resolved.session.resources) {
    if (resource.type !== "memory_store") {
      resources.push({ ...resource });
      continue;
    }
    const memoryStoreId = typeof resource.memoryStoreId === "string"
      ? resource.memoryStoreId
      : typeof resource.memory_store_id === "string"
        ? resource.memory_store_id
        : "";
    if (memoryStoreId.length === 0) {
      throw new Error("Managed Session Memory Store resource requires memory_store_id");
    }
    const access = resource.access === "read_only" ? "read_only" : "read_write";
    const snapshot = await source.materializeManagedMemorySnapshot({
      ...input,
      memoryStoreId,
      access,
    });
    if (snapshot.type !== "found") {
      throw new Error(`Managed Session Memory Store ${memoryStoreId} was not found`);
    }
    resources.push({
      ...resource,
      runtimeMountStoreId: snapshot.mountStoreId,
    });
  }
  return {
    resources,
    fileSource: {
      downloadFile: async (fileId) => {
        const downloaded = await source.downloadManagedSessionFile({
          ...input,
          fileId,
        });
        if (downloaded.type !== "found") {
          throw new Error(`Managed Session file ${fileId} was not found`);
        }
        return { content: downloaded.content };
      },
    },
  };
}

/**
 * Mount session resources into the sandbox during warmup.
 *
 * Resource types (aligned with Anthropic + our extensions):
 * - file:              Mount file content at a path
 * - github_repository: Clone repo with auth, checkout branch/commit
 * - memory_store:      Mount /mnt/memory/<store_name>/ from MEMORY_BUCKET (R2)
 * - env:               Set process env vars (was env_secret pre-rename)
 *
 * Security model:
 * - authorization_token is write-only (never in API responses)
 * - Git credentials stored via `git credential approve` (per-repo, per-host)
 * - Tokens not visible via `git remote -v`
 * - Memory store mounts are R2 prefix-scoped to the store_id; read_only
 *   attachments mount with readOnly:true so writes from the agent fail.
 * - env values are written via sandbox.setEnvVars in a single batched
 *   call so all the agent's exec calls see the same env. Values come
 *   from the per-session secret store keyed by resource_id.
 */
export async function mountResources(
  sandbox: SandboxExecutor,
  resources: Array<Record<string, unknown>>,
  kv: KVNamespace,
  secretStore?: Map<string, string>,
  filesBucket?: R2Bucket,
  tenantId?: string,
  memoryStoreLookup?: (storeId: string) => Promise<{ name: string } | null>,
  fileSource?: ManagedSessionFileSource,
): Promise<void> {
  validateResourcesBeforeMount(
    sandbox,
    resources,
    secretStore,
    filesBucket,
    tenantId,
    fileSource,
  );
  let hasGitRepo = false;
  // Buffer env vars across the loop so we make a single setEnvVars call
  // at the end. setEnvVars on most sandbox implementations is a network
  // round-trip per call; one batched call beats one-per-resource.
  const envBatch: Record<string, string> = {};

  for (const res of resources) {
    switch (res.type) {
      case "file":
        await mountFile(sandbox, res, filesBucket, tenantId, fileSource);
        break;
      case "github_repository":
      case "github_repo": {
        hasGitRepo = true;
        // Token is no longer pulled into the sandbox — the agent worker's
        // outbound proxy injects Authorization on every github.com /
        // api.github.com call by RPC-ing main per request. mountGitRepo
        // therefore clones / fetches with no auth surface inside the
        // container; the proxy makes those calls succeed.
        await mountGitRepo(sandbox, res);
        break;
      }
      case "memory_store":
        await mountMemoryStore(sandbox, res, memoryStoreLookup);
        break;
      case "env":
      case "env_secret": {
        // env_secret kept for any session row that predates the rename
        // (sessions.ts:262). New rows always land as type=env.
        const resId = res.id as string;
        const name = res.name as string;
        envBatch[name] = secretStore!.get(resId)!;
        break;
      }
    }
  }

  // kv reserved for future use (memory_store, etc.); intentionally unused for files now.
  void kv;

  // Apply collected env vars in a single call after preflight proves the
  // sandbox and every sealed value are available.
  if (Object.keys(envBatch).length > 0) {
    await sandbox.setEnvVars!(envBatch);
  }

  // Install gh CLI when a GitHub repo is mounted
  if (hasGitRepo) {
    try {
      await ensureGhCli(sandbox);
    } catch (err) {
      // Best-effort: agent can still use git + curl as fallback
      logWarn(
        { op: "resource.gh_cli_install", err },
        "gh CLI install failed; agent will fall back to git + curl",
      );
    }
  }
}

function validateResourcesBeforeMount(
  sandbox: SandboxExecutor,
  resources: Array<Record<string, unknown>>,
  secretStore: Map<string, string> | undefined,
  filesBucket: R2Bucket | undefined,
  tenantId: string | undefined,
  fileSource: ManagedSessionFileSource | undefined,
): void {
  for (const resource of resources) {
    switch (resource.type) {
      case "file":
        if (
          typeof (resource.fileId ?? resource.file_id) !== "string"
          || String(resource.fileId ?? resource.file_id).trim().length === 0
        ) {
          throw new Error("Session file resource requires file_id");
        }
        if (fileSource === undefined && (filesBucket === undefined || tenantId === undefined)) {
          throw new Error("Session file resource requires tenant-scoped FILES_BUCKET storage");
        }
        if (sandbox.writeFileBytes === undefined) {
          throw new Error("Session file resource requires binary sandbox writes");
        }
        break;
      case "github_repository":
      case "github_repo": {
        const repositoryUrl = typeof resource.url === "string"
          ? resource.url
          : typeof resource.repo_url === "string"
            ? resource.repo_url
            : "";
        if (repositoryUrl.trim().length === 0) {
          throw new Error("Session GitHub repository resource requires a URL");
        }
        if (resource.checkout && typeof resource.checkout === "object") {
          const checkout = resource.checkout as {
            type?: unknown;
            name?: unknown;
            sha?: unknown;
          };
          if (checkout.type === "branch") {
            const name = typeof checkout.name === "string" ? checkout.name : "";
            if (
              !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
              || name.includes("..")
              || name.endsWith("/")
              || name.endsWith(".")
            ) {
              throw new Error("Session repository has an invalid Git branch");
            }
          } else if (checkout.type === "commit") {
            const sha = typeof checkout.sha === "string" ? checkout.sha : "";
            if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
              throw new Error("Session repository has an invalid Git commit SHA");
            }
          } else if (checkout.type !== undefined) {
            throw new Error("Session repository has an unsupported checkout type");
          }
        }
        break;
      }
      case "memory_store":
        if (
          typeof resource.memory_store_id !== "string"
          && typeof resource.memoryStoreId !== "string"
          && typeof resource.id !== "string"
        ) {
          throw new Error("Session Memory Store resource requires memory_store_id");
        }
        if (sandbox.mountMemoryStore === undefined) {
          throw new Error("Session Memory Store resource requires a sandbox memory mount Port");
        }
        break;
      case "env":
      case "env_secret": {
        const id = typeof resource.id === "string" ? resource.id : "";
        const name = typeof resource.name === "string" ? resource.name : "";
        if (id.length === 0 || name.length === 0 || !secretStore?.has(id)) {
          throw new Error("Session env resource requires its sealed secret value");
        }
        if (sandbox.setEnvVars === undefined) {
          throw new Error("Session env resource requires sandbox environment injection");
        }
        break;
      }
      default:
        throw new Error(`Unsupported Session resource type: ${String(resource.type)}`);
    }
  }
}

async function mountFile(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
  filesBucket: R2Bucket | undefined,
  tenantId: string | undefined,
  fileSource: ManagedSessionFileSource | undefined,
): Promise<void> {
  const fileId = (res.fileId as string | undefined) ?? (res.file_id as string);
  const bytes = fileSource === undefined
    ? await (async () => {
        const obj = await filesBucket!.get(fileR2Key(tenantId!, fileId));
        if (!obj) return null;
        return new Uint8Array(await obj.arrayBuffer());
      })()
    : (await fileSource.downloadFile(fileId)).content;
  if (bytes === null) throw new Error(`Session file ${fileId} was not found`);
  // Default mount path matches Anthropic Managed Agents convention.
  const path = (res.mountPath as string | undefined)
    ?? (res.mount_path as string | undefined)
    ?? `/mnt/session/uploads/${fileId}`;
  await sandbox.writeFileBytes!(path, bytes);
}

/**
 * Mount a memory store at /mnt/memory/<store_name>/. Looks up the store name
 * from the platform's memory service (passed in via `memoryStoreLookup`) so
 * we don't need to plumb env / D1 directly into the resource mounter — keeps
 * this module test-friendly.
 */
async function mountMemoryStore(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
  lookup: ((storeId: string) => Promise<{ name: string } | null>) | undefined,
): Promise<void> {
  const storeId = (res.memoryStoreId as string | undefined)
    ?? (res.memory_store_id as string | undefined)
    ?? (res.id as string);
  const mountStoreId = typeof res.runtimeMountStoreId === "string"
    ? res.runtimeMountStoreId
    : storeId;

  // The public contract mounts by store name, not id. Falling back to the id
  // makes the attachment exist at a path the prompt/user never declared, so
  // treat missing metadata as a preparation failure.
  const declaredName = typeof res.name === "string" ? res.name : undefined;
  if (!declaredName && !lookup) {
    throw new Error(`Memory Store ${storeId} requires a metadata lookup Port`);
  }
  let storeName = declaredName;
  if (!storeName) {
    let meta: { name: string } | null;
    try {
      meta = await lookup!(storeId);
    } catch (err) {
      throw new Error(
        `Memory Store ${storeId} metadata lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!meta?.name) throw new Error(`Memory Store ${storeId} was not found`);
    storeName = meta.name;
  }

  const access = res.access as string | undefined;
  const readOnly = access === "read_only";

  await sandbox.mountMemoryStore!({
    storeName,
    storeId: mountStoreId,
    readOnly,
  });
  const mountPath = (res.mountPath as string | undefined)
    ?? (res.mount_path as string | undefined)
    ?? `/mnt/memory/${storeName}`;
  await sandbox.setEnvVars?.({
    OMA_MEMORY_DIR: "/mnt/memory",
    [`OMA_MEMORY_${storeName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]: mountPath,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertRepositoryCommandSucceeded(command: string, output: string): void {
  const prefixedExit = /^exit=(-?\d+)/u.exec(output);
  const suffixedExit = /\[exit (?:exit=)?(-?\d+)\]/u.exec(output);
  const failed = (prefixedExit !== null && Number(prefixedExit[1]) !== 0)
    || (suffixedExit !== null && Number(suffixedExit[1]) !== 0)
    || output.includes("[error:")
    || output.includes("[exit signal=");
  if (failed) {
    throw new Error(`Repository command failed: ${command}: ${output}`);
  }
}

async function runRequiredRepositoryCommand(
  sandbox: SandboxExecutor,
  command: string,
  timeoutMs: number,
): Promise<void> {
  const output = await sandbox.exec(command, timeoutMs);
  assertRepositoryCommandSucceeded(command, output);
}

async function mountGitRepo(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
): Promise<void> {
  const repoUrl = res.url as string || res.repo_url as string;

  const targetDir = (res.mountPath as string | undefined)
    ?? (res.mount_path as string | undefined)
    ?? "/workspace";

  // Disable interactive credential prompting BEFORE any git network call.
  // The network-layer proxy (apps/agent/src/oma-sandbox.ts githubAuthHandler)
  // injects Authorization on every github.com / api.github.com request, so
  // the happy path never sees a 401 inside git. If the proxy fails to
  // resolve a token (no github_repository resource matched, RPC error, …),
  // git would otherwise hang waiting for stdin or invoke a GUI askpass —
  // /bin/true returns immediately so git fails fast and surfaces an error
  // to the agent. No credential helper is configured at all on purpose:
  // ~/.git-credentials and credential.helper are intentionally unset so
  // the only auth path is the worker proxy.
  await runRequiredRepositoryCommand(
    sandbox,
    `git config --global core.askpass /bin/true && ` +
    `git config --global credential.helper "" && ` +
    `(git config --global --unset-all credential.helper 2>/dev/null || true)`,
    5000,
  );

  // Clone the repo's default branch first. Branch checkout is handled
  // separately below so we can fall back to creating a new local branch
  // when the requested name doesn't exist on the remote.
  if (sandbox.gitCheckout) {
    await sandbox.gitCheckout(repoUrl, { targetDir });
  } else {
    await runRequiredRepositoryCommand(
      sandbox,
      `git clone -- ${shellQuote(repoUrl)} ${shellQuote(targetDir)} 2>&1`,
      120000,
    );
  }

  // Configure git user
  await runRequiredRepositoryCommand(
    sandbox,
    `cd ${shellQuote(targetDir)} && git config user.name "Agent" && git config user.email "agent@managed-agents.dev"`,
    10000
  );

  const checkout = res.checkout as { type?: string; name?: string; sha?: string } | undefined;
  if (checkout?.type === "branch" && checkout.name) {
    // Try fetch + checkout (DWIM creates a local tracking branch when
    // origin/<name> exists). If the remote doesn't have the branch,
    // create it locally off the just-cloned default HEAD instead of
    // failing the whole mount.
    const branch = checkout.name;
    await runRequiredRepositoryCommand(
      sandbox,
      `cd ${shellQuote(targetDir)} && (git fetch origin ${shellQuote(`${branch}:refs/remotes/origin/${branch}`)} 2>/dev/null && git checkout ${shellQuote(branch)}) || git checkout -b ${shellQuote(branch)}`,
      60000,
    );
  } else if (checkout?.type === "commit" && checkout.sha) {
    await runRequiredRepositoryCommand(
      sandbox,
      `cd ${shellQuote(targetDir)} && git checkout ${shellQuote(checkout.sha)}`,
      30000,
    );
  }
}

/**
 * Install GitHub CLI (gh) if not already present.
 * Auto-triggered when a github_repository resource is mounted.
 */
async function ensureGhCli(sandbox: SandboxExecutor): Promise<void> {
  // Check if already installed
  const check = await sandbox.exec("which gh 2>/dev/null && echo OK || echo MISSING", 5000);
  if (check.includes("OK")) return;

  // Install gh CLI via official script
  await sandbox.exec(
    `(type -p wget >/dev/null || (apt-get update && apt-get install wget -y -qq)) && ` +
    `mkdir -p -m 755 /etc/apt/keyrings && ` +
    `wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && ` +
    `chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && ` +
    `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && ` +
    `apt-get update -qq && apt-get install gh -y -qq 2>&1`,
    120000
  );
}
