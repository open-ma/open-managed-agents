import type { SandboxExecutor } from "../harness/interface";

/**
 * Mount session resources into the sandbox during warmup.
 *
 * Resource types (aligned with Anthropic + our extensions):
 * - file:              Mount file content at a path
 * - github_repository: Clone repo with auth, checkout branch/commit
 *
 * Security model:
 * - authorization_token is write-only (never in API responses)
 * - Git credentials stored via `git credential approve` (per-repo, per-host)
 * - Tokens not visible via `git remote -v`
 */
export async function mountResources(
  sandbox: SandboxExecutor,
  resources: Array<Record<string, unknown>>,
  kv: KVNamespace,
  secretStore?: Map<string, string>,
): Promise<void> {
  let hasGitRepo = false;
  let lastGitToken: string | null = null;

  for (const res of resources) {
    try {
      switch (res.type) {
        case "file":
          await mountFile(sandbox, res, kv);
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
      }
    } catch {
      // Best-effort: skip failed resource, don't crash session
    }
  }

  // Register last token for gh CLI (gh only supports one GH_TOKEN)
  if (lastGitToken && sandbox.registerCommandSecrets) {
    sandbox.registerCommandSecrets("gh", { GITHUB_TOKEN: lastGitToken, GH_TOKEN: lastGitToken });
  }

  // Install gh CLI when a GitHub repo is mounted
  if (hasGitRepo) {
    try {
      await ensureGhCli(sandbox);
    } catch {
      // Best-effort: agent can still use git + curl as fallback
    }
  }
}

async function mountFile(
  sandbox: SandboxExecutor,
  res: Record<string, unknown>,
  kv: KVNamespace,
): Promise<void> {
  if (!res.file_id) return;
  const content = await kv.get(`filecontent:${res.file_id}`);
  if (!content) return;
  const path = (res.mount_path as string) || `/workspace/${res.file_id}`;
  await sandbox.writeFile(path, content);
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
