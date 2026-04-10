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
 * - Git token wired into credential store (not visible via `git remote -v`)
 */
export async function mountResources(
  sandbox: SandboxExecutor,
  resources: Array<Record<string, unknown>>,
  kv: KVNamespace,
  secretStore?: Map<string, string>,
): Promise<void> {
  let hasGitRepo = false;

  for (const res of resources) {
    try {
      switch (res.type) {
        case "file":
          await mountFile(sandbox, res, kv);
          break;
        case "github_repository":
        case "github_repo":
          hasGitRepo = true;
          await mountGitRepo(sandbox, res, secretStore);
          break;
      }
    } catch {
      // Best-effort: skip failed resource, don't crash session
    }
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
  secretStore?: Map<string, string>,
): Promise<void> {
  const repoUrl = res.url as string || res.repo_url as string;
  if (!repoUrl) return;

  const resId = res.id as string;
  const token = resId ? secretStore?.get(resId) || null : null;
  const targetDir = (res.mount_path as string) || "/workspace";

  // Clone repo (token in URL for clone only)
  if (sandbox.gitCheckout) {
    const cloneUrl = token ? repoUrl.replace("https://", `https://${token}@`) : repoUrl;
    const checkout = res.checkout as { type?: string; name?: string; sha?: string } | undefined;
    await sandbox.gitCheckout(cloneUrl, {
      branch: checkout?.type === "branch" ? checkout.name : undefined,
      targetDir,
    });
  } else {
    const cloneUrl = token ? repoUrl.replace("https://", `https://${token}@`) : repoUrl;
    await sandbox.exec(`git clone ${cloneUrl} ${targetDir} 2>&1`, 120000);
  }

  // Configure git
  await sandbox.exec(
    `cd ${targetDir} && git config user.name "Agent" && git config user.email "agent@managed-agents.dev"`,
    10000
  );

  // Clean remote URL (hide token from `git remote -v`)
  if (token) {
    await sandbox.exec(`cd ${targetDir} && git remote set-url origin ${repoUrl}`, 10000);

    // Set up credential helper that reads GITHUB_TOKEN from environment
    // This makes `git push` work with per-exec env var injection
    await sandbox.exec(
      `cd ${targetDir} && git config credential.helper '!f() { echo "username=x-access-token"; echo "password=\${GITHUB_TOKEN}"; }; f'`,
      10000
    );

    // Register token as per-command secret for git/gh commands only
    // Agent running `echo $GITHUB_TOKEN` or `env` sees nothing
    if (sandbox.registerCommandSecrets) {
      const secrets = { GITHUB_TOKEN: token, GH_TOKEN: token };
      sandbox.registerCommandSecrets("git", secrets);
      sandbox.registerCommandSecrets("gh", secrets);
      // Also cover `cd /workspace && git push` patterns
      sandbox.registerCommandSecrets("cd ", secrets);
    }
  }

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
