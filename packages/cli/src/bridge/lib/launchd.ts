/**
 * macOS launchd plist install/uninstall.
 *
 * KeepAlive=true → if the daemon crashes / is killed, launchd restarts it
 * within ~10s. RunAtLoad=true → launchd starts it on load (boot or `load`).
 * StandardOutPath / StandardErrorPath → logs go to ~/Library/Logs/oma/
 * so users can `tail -f` without dealing with `log show` filters.
 *
 * Why we call node directly instead of the `oma` shim: the shim's shebang
 * is `#!/usr/bin/env node`, and launchd does NOT source the user's shell
 * init — so on nvm/asdf/volta machines `env node` fails with 127 and the
 * daemon never starts (KeepAlive then loops forever, see issue logs).
 * We freeze process.execPath at setup time as the absolute node path and
 * point ProgramArguments at the cli's dist/index.js directly. dirname(node)
 * is also prepended to EnvironmentVariables.PATH so spawned ACP children
 * (which still carry `#!/usr/bin/env node` shebangs) can resolve node too.
 * This is the same pattern PM2 uses for `pm2 startup` — the working node
 * path at setup is the one we commit to. Users who later nvm-uninstall
 * that node version need to re-run `oma bridge setup` (or the daemon
 * loops 127 again). That re-setup is a one-liner so we accept the cost
 * over the alternatives (ship our own node, write shell wrappers per
 * version manager, etc).
 */

import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { paths, currentPlatform } from "./platform.js";
import { buildPlist, type BuilderOpts } from "./service-templates.js";

export type InstallOptions = BuilderOpts;
// Re-export for back-compat with anything that imports buildPlist from
// here. The actual implementation lives in service-templates so unit
// tests can exercise it without importing node:child_process.
export { buildPlist };

export async function install(opts: InstallOptions): Promise<void> {
  if (currentPlatform() !== "darwin") {
    throw new Error(
      `launchd install only supported on macOS. Run \`oma bridge daemon\` in foreground or wire your own systemd unit.`,
    );
  }
  const p = paths();
  if (!p.serviceFile) throw new Error("no service file path on this platform");

  await mkdir(dirname(p.logFile), { recursive: true });
  await mkdir(dirname(p.serviceFile), { recursive: true });

  await writeFile(p.serviceFile, buildPlist(opts), "utf-8");

  // Reload — `unload` is best-effort (plist may not be loaded yet); the
  // load that follows is the one that must succeed.
  await runLaunchctl(["unload", p.serviceFile]).catch(() => undefined);
  await runLaunchctl(["load", "-w", p.serviceFile]);
}

export async function uninstall(): Promise<{ removed: boolean }> {
  if (currentPlatform() !== "darwin") {
    return { removed: false };
  }
  const p = paths();
  if (!p.serviceFile) return { removed: false };

  await runLaunchctl(["unload", p.serviceFile]).catch(() => undefined);
  try {
    await unlink(p.serviceFile);
    return { removed: true };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { removed: false };
    throw e;
  }
}

function runLaunchctl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("launchctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    p.once("error", reject);
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`launchctl ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Read the cliEntry path the currently-installed plist points at, or null
 * if no plist is installed / can't be parsed. Used by `oma bridge setup` to
 * detect when an npm upgrade landed a new dist/index.js but the plist still
 * points at an older build (often a dev path under the project tree).
 */
export async function readInstalledCliEntry(): Promise<string | null> {
  const p = paths();
  if (!p.serviceFile) return null;
  let xml: string;
  try {
    xml = await readFile(p.serviceFile, "utf-8");
  } catch {
    return null;
  }
  // ProgramArguments is an array; second <string> is the cli entry (first is
  // the node binary). Match the array contents and pick element [1].
  const arr = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!arr) return null;
  const strings = [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  return strings[1] ?? null;
}
