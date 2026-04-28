/**
 * Credentials + machine-id persistence.
 *
 * `credentials.json` is mode 0600 (owner read/write only) — the runtime
 * token is a long-lived bearer credential and we don't want any
 * user/group on the box reading it. The directory is mode 0700 so the
 * file's permissions can't be evaded by traversing the parent.
 *
 * `machine-id` is just a UUID generated on first run and persisted —
 * survives daemon reinstalls but is per-user (same machine, different
 * unix user → different machine_id, by design; runtimes are per-user).
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./platform.js";

export interface Credentials {
  /** API root, e.g. "https://app.openma.dev". WS attach swaps https→wss. */
  serverUrl: string;
  /** Runtime row id returned by /agents/runtime/exchange. */
  runtimeId: string;
  /** sk_machine_… — bearer token for /agents/runtime/_attach. */
  token: string;
  /**
   * `oma_*` API key the daemon hands to spawned ACP children as the
   * `mcpServers[].authorization_token` so they can call OMA's mcp-proxy.
   * Issued by the server during /exchange so the user never needs a
   * separate login step on the daemon machine.
   */
  agentApiKey?: string;
  /** Echoed for diagnostics; daemon also reads machineIdFile directly. */
  machineId: string;
  /** When this machine was first registered (unix seconds). */
  createdAt: number;
}

export async function readCreds(): Promise<Credentials | null> {
  // We deliberately do NOT migrate from any "legacy" config dir. The shared
  // `~/.config/oma/credentials.json` belongs to `oma auth login` and has a
  // different shape (Pattern A multi-tenant token bag); reusing those bytes
  // here would silently overwrite the user's CLI auth.
  try {
    const text = await readFile(paths().credsFile, "utf-8");
    return JSON.parse(text) as Credentials;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCreds(creds: Credentials): Promise<void> {
  const file = paths().credsFile;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod again in case the file already existed with looser perms.
  await chmod(file, 0o600);
}

export async function deleteCreds(): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(paths().credsFile);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Get-or-create the per-user machine fingerprint. Generated once and
 * persisted; survives daemon reinstalls but is not tied to hardware
 * (so a `~` restore from backup keeps the same id, which is what we
 * want — the user's runtime continues to be "the same machine").
 */
export async function getOrCreateMachineId(): Promise<string> {
  const file = paths().machineIdFile;
  try {
    const id = (await readFile(file, "utf-8")).trim();
    if (id.length >= 32) return id;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const id = randomUUID();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, id + "\n", { mode: 0o600 });
  return id;
}
