import type { SandboxExecutor } from "../harness/interface";
import { fileR2Key } from "@open-managed-agents/shared";
import { logWarn } from "@open-managed-agents/shared";

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
): Promise<void> {
  let hasGitRepo = false;
  let lastGitToken: string | null = null;
  // Buffer env vars across the loop so we make a single setEnvVars call
  // at the end. setEnvVars on most sandbox implementations is a network
  // round-trip per call; one batched call beats one-per-resource.
  const envBatch: Record<string, string> = {};

  for (const res of resources) {
    try {
      switch (res.type) {
        case "file":
          await mountFile(sandbox, res, filesBucket, tenantId);
          break;
        case "github_repository":
        case "github_repo": {
          hasGitRepo = true;
          const resId = res.id as string;
          const token = resId ? secretStore?.get(resId) || null : null;
          if (token) lastGitToken = token;
          await mountGitRepo(sandbox, res, token);
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
          const value = resId ? secretStore?.get(resId) : undefined;
          if (name && value) envBatch[name] = value;
          break;
        }
      }
    } catch (err) {
      // Best-effort: skip failed resource, don't crash session. Resources are
      // fungible during a session so a bad mount degrades gracefully — but a
      // user whose repo silently failed to mount needs to know why.
      logWarn(
        { op: "resource.mount", resource_type: res.type, resource_id: res.id, err },
        "resource mount failed; skipping",
      );
    }
  }

  // kv reserved for future use (memory_store, etc.); intentionally unused for files now.
  void kv;

  // Register last token for gh CLI (gh only supports one GH_TOKEN)
  if (lastGitToken && sandbox.registerCommandSecrets) {
    sandbox.registerCommandSecrets("gh", { GITHUB_TOKEN: lastGitToken, GH_TOKEN: lastGitToken });
  }

  // Apply collected env vars in a single call. setEnvVars is optional on
  // SandboxExecutor (some test fakes omit it) — silently skip when
  // unsupported so an env resource on a stripped-down sandbox doesn't
  // crash the whole mount pass. Logged as a warn so the gap is visible.
  if (Object.keys(envBatch).length > 0) {
    if (sandbox.setEnvVars) {
      // Names only — values are session secrets; never logged.
      try {
        await sandbox.setEnvVars(envBatch);
      } catch (err) {
        logWarn({ op: "resource.env_apply", count: Object.keys(envBatch).length, err }, "setEnvVars failed");
      }
    } else {
      logWarn(
        { op: "resource.env_apply", count: Object.keys(envBatch).length },
        "sandbox does not support setEnvVars; env resources skipped",
      );
    }
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

async function mountFile(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
  filesBucket: R2Bucket | undefined,
  tenantId: string | undefined,
): Promise<void> {
  if (!res.file_id || !filesBucket || !tenantId) return;
  const obj = await filesBucket.get(fileR2Key(tenantId, res.file_id as string));
  if (!obj) return;
  // Default mount path matches Anthropic Managed Agents convention.
  const path = (res.mount_path as string) || `/mnt/session/uploads/${res.file_id}`;
  const buf = await obj.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (sandbox.writeFileBytes) {
    await sandbox.writeFileBytes(path, bytes);
  } else {
    // Legacy fallback: best-effort UTF-8 decode. Will corrupt binary.
    await sandbox.writeFile(path, new TextDecoder("utf-8").decode(bytes));
  }
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
  if (!sandbox.mountMemoryStore) {
    logWarn(
      { op: "resource.mount.memory_store_unsupported" },
      "sandbox does not support memory_store mounts; skipping",
    );
    return;
  }
  const storeId = (res.memory_store_id as string) || (res.id as string);
  if (!storeId) return;

  // Discover the store name (used as the mount directory). Fall back to
  // the storeId itself if the lookup can't find / can't run — name is
  // human-friendly but not security-critical (path scoping is by storeId).
  let storeName = storeId;
  if (lookup) {
    try {
      const meta = await lookup(storeId);
      if (meta?.name) storeName = meta.name;
    } catch (err) {
      logWarn(
        { op: "resource.mount.memory_store_lookup", store_id: storeId, err },
        "memory store name lookup failed; falling back to id",
      );
    }
  }

  const access = res.access as string | undefined;
  const readOnly = access === "read_only";

  await sandbox.mountMemoryStore({
    storeName,
    storeId,
    readOnly,
  });
}

async function mountGitRepo(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
  token: string | null,
): Promise<void> {
  const repoUrl = res.url as string || res.repo_url as string;
  if (!repoUrl) return;

  const targetDir = (res.mount_path as string) || "/workspace";

  // Store credential BEFORE clone so git can auth automatically
  if (token) {
    // Write credential to .git-credentials (per-repo, per-host)
    // Format: https://user:token@host/path.git (one per line)
    try {
      const url = new URL(repoUrl);
      const credLine = `https://x-access-token:${token}@${url.hostname}${url.pathname}`;
      await sandbox.exec(`git config --global credential.helper store`, 5000);
      const writeResult = await sandbox.exec(`echo '${credLine.replace(/'/g, "'\\''")}' >> $HOME/.git-credentials && chmod 600 $HOME/.git-credentials && echo CRED_OK`, 5000);
      if (!writeResult.includes("CRED_OK")) {
        console.error("[resource-mounter] credential write failed:", writeResult);
      }
    } catch (err) {
      console.error("[resource-mounter] credential setup error:", err);
    }
  }

  // Clone repo
  if (sandbox.gitCheckout) {
    const checkout = res.checkout as { type?: string; name?: string; sha?: string } | undefined;
    await sandbox.gitCheckout(repoUrl, {
      branch: checkout?.type === "branch" ? checkout.name : undefined,
      targetDir,
    });
  } else {
    await sandbox.exec(`git clone ${repoUrl} ${targetDir} 2>&1`, 120000);
  }

  // Configure git user
  await sandbox.exec(
    `cd ${targetDir} && git config user.name "Agent" && git config user.email "agent@managed-agents.dev"`,
    10000
  );

  // Handle checkout (commit SHA)
  const checkout = res.checkout as { type?: string; name?: string; sha?: string } | undefined;
  if (checkout?.type === "commit" && checkout.sha) {
    await sandbox.exec(`cd ${targetDir} && git checkout ${checkout.sha}`, 30000);
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
