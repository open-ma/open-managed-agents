import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function changesetPublishArgs() {
  // Changesets reads .changeset/pre.json itself. In pre mode it derives the
  // npm dist-tag from that file and rejects an explicit --tag argument.
  return ["publish"];
}

async function main() {
  const args = changesetPublishArgs();
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify({ command: "changeset", args }));
    return;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpm, ["exec", "changeset", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}
