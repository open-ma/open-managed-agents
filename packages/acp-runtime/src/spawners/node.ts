/**
 * NodeSpawner — `child_process.spawn` adapter to the cross-host ChildHandle
 * shape. Used by clash-bridge and any other Node-resident host (desktop
 * shells, dev tooling, tests).
 *
 * Why we wrap, not re-export:
 *   - Node child_process gives us Node Readable/Writable streams. ACP SDK +
 *     this package's interfaces speak Web ReadableStream/WritableStream<Uint8Array>.
 *     `Readable.toWeb()` / `Writable.toWeb()` (Node 18+) bridges them.
 *   - `kill()` semantics: child_process.kill() returns synchronously. We
 *     promise-wait on the `exit` event so callers can `await kill()` and
 *     trust the process is actually gone.
 *   - `exited` resolves once with `{ code, signal }` even if both events
 *     fire (Node fires `exit` then `close`; we settle on the first).
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { AgentSpec, ChildHandle, Spawner } from "../types.js";

export class NodeSpawner implements Spawner {
  async spawn(spec: AgentSpec): Promise<ChildHandle> {
    // stdio: [stdin, stdout, stderr] all piped — we own all three streams.
    // Inheriting stderr would dump child noise into the bridge's own stderr
    // and lose it from any structured log we set up; keep it captured.
    //
    // env merge semantics: parent env is inherited, then spec.env overrides.
    // A spec.env entry with `undefined` value EXPLICITLY UNSETS the inherited
    // key — used by callers who need the child to look like it's not running
    // inside another agent (e.g. unsetting CLAUDECODE so claude-agent-acp
    // doesn't refuse to spawn nested-session-style).
    const merged: Record<string, string | undefined> = {
      ...process.env,
      ...(spec.env ?? {}),
    };
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") env[k] = v;
    }
    const child: ChildProcessWithoutNullStreams = nodeSpawn(spec.command, spec.args ?? [], {
      env,
      cwd: spec.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // node:stream → Web stream. Node 18+ exposes `.toWeb()` on these classes;
    // they're not in the @types/node defaults everywhere, so we narrow.
    const stdin = (Writable as unknown as {
      toWeb(s: NodeJS.WritableStream): WritableStream<Uint8Array>;
    }).toWeb(child.stdin);
    const stdout = (Readable as unknown as {
      toWeb(s: NodeJS.ReadableStream): ReadableStream<Uint8Array>;
    }).toWeb(child.stdout);
    const stderr = (Readable as unknown as {
      toWeb(s: NodeJS.ReadableStream): ReadableStream<Uint8Array>;
    }).toWeb(child.stderr);

    // Single resolution of `exited` — first of (exit, close) wins.
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      let settled = false;
      const settle = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };
      child.once("exit", settle);
      child.once("close", settle);
      // Spawn errors (e.g. ENOENT for missing command) fire before exit. Map
      // to a synthetic exit so callers waiting on `exited` don't hang forever.
      child.once("error", () => settle(null, null));
    });

    const kill = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await exited;
    };

    return { stdin, stdout, stderr, kill, exited };
  }
}
