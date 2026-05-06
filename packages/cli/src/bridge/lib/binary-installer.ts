/**
 * Binary wrapper installer — fetch, extract, and link an ACP wrapper
 * from a release archive. Used by the wrapper-audit flow when a
 * `KnownAgentEntry` carries `install: { kind: "binary", archives, … }`.
 *
 * Why this exists: the official ACP registry distributes 14+ wrappers as
 * GitHub-release tarballs/zips (codex-acp, opencode, goose, …) rather
 * than npm packages. Forcing the user to read a download URL out of the
 * audit and curl/extract by hand is a footgun — most copy the URL,
 * extract somewhere weird, and then OMA's detect can't find the binary
 * because it's not on PATH. So we own the download → extract → symlink
 * dance ourselves.
 *
 * Layout:
 *   - Archive temp file:  <os.tmpdir()>/oma-<id>-<rand>.<ext>
 *   - Extracted payload:  ~/.local/share/oma/wrappers/<id>/
 *   - PATH symlink:       ~/.local/bin/<basename(cmd)>
 *
 * The symlink target points into the wrapper dir, so an `oma upgrade`
 * (re-extract) replaces both atomically. The PATH dir matches the XDG
 * convention most modern shells already include in $PATH; if not, we
 * print a one-line hint telling the user how to add it.
 *
 * Extraction shells out to `tar` (universal on macOS / Linux, available
 * on Windows 10+) for .tar.gz / .tar.bz2 / .tar.xz, and to `unzip` for
 * .zip. Both are tiny dependencies that ship with every reasonable dev
 * environment; Node-side libraries would just bring in slow JS impls of
 * the same algorithms.
 */

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { mkdirSync, rmSync, chmodSync, existsSync, symlinkSync, unlinkSync, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ReadableStream as WebReadableStream } from "node:stream/web";

export type BinaryInstall = {
  kind: "binary";
  archives: Partial<Record<string, { url: string; cmd: string }>>;
  downloadUrl?: string;
};

export interface InstallResult {
  ok: boolean;
  /** Symlink path on PATH (only set when ok). */
  binPath?: string;
  /** Final wrapper-dir path (only set when ok). */
  installedAt?: string;
  /** Failure reason for log.warn / hint formatting. */
  error?: string;
  /** Hint to surface to the user (e.g., add `~/.local/bin` to PATH). */
  hint?: string;
}

/** OS-arch key matching the official ACP registry's `binary.<key>` map
 *  (`darwin-aarch64`, `linux-x86_64`, …). */
export function platformKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" :
    process.arch === "x64"   ? "x86_64"  :
    process.arch;
  return `${os}-${arch}`;
}

const WRAPPERS_DIR = join(homedir(), ".local", "share", "oma", "wrappers");
const BIN_DIR = join(homedir(), ".local", "bin");

export interface InstallOpts {
  id: string;
  install: BinaryInstall;
  /** Stream progress (download bytes, extract step) to stderr. */
  onProgress?: (msg: string) => void;
}

export async function installBinaryWrapper(opts: InstallOpts): Promise<InstallResult> {
  const archive = opts.install.archives[platformKey()];
  if (!archive) {
    return {
      ok: false,
      error: `no archive for ${platformKey()}`,
      hint: opts.install.downloadUrl
        ? `manual install: ${opts.install.downloadUrl}`
        : undefined,
    };
  }

  // Resolve cmd → flat parts. Registry uses leading "./"; strip and
  // split so we can recompose the relative path inside the wrapper dir
  // without normpath surprises.
  const cmdRel = archive.cmd.replace(/^\.\//, "");
  const binName = basename(cmdRel).replace(/\.exe$/, "");
  const wrapperDir = join(WRAPPERS_DIR, opts.id);
  const cmdAbs = join(wrapperDir, cmdRel);
  const linkPath = join(BIN_DIR, binName);

  // Fresh extract every time — if the user is re-installing, the
  // previous payload may have a different version and we want to swap
  // it cleanly. rmSync force=true is a no-op when the dir is missing.
  try { rmSync(wrapperDir, { recursive: true, force: true }); }
  catch (e) { return { ok: false, error: `wipe stale wrapper dir failed: ${(e as Error).message}` }; }
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });

  // Download to a uniquely-named temp file. Random suffix so two
  // concurrent installs of the same id don't fight over the same path.
  const ext = guessExtension(archive.url);
  const tmpFile = join(tmpdir(), `oma-${opts.id}-${randomBytes(4).toString("hex")}${ext}`);
  try {
    opts.onProgress?.(`downloading ${archive.url}`);
    await downloadToFile(archive.url, tmpFile, opts.onProgress);

    opts.onProgress?.(`extracting to ${wrapperDir}`);
    await extractArchive(tmpFile, wrapperDir, ext);

    if (!existsSync(cmdAbs)) {
      return {
        ok: false,
        error: `extracted archive missing expected cmd: ${cmdRel}`,
      };
    }
    chmodSync(cmdAbs, 0o755);

    // Replace any prior symlink atomically. unlink+symlink is racy in
    // the abstract but fine here — we own this filename and we're not
    // competing with another writer.
    try { unlinkSync(linkPath); } catch { /* missing is fine */ }
    symlinkSync(cmdAbs, linkPath);

    const result: InstallResult = { ok: true, binPath: linkPath, installedAt: wrapperDir };
    if (!isOnPath(BIN_DIR)) {
      result.hint = `add \`${BIN_DIR}\` to your PATH (it's where OMA installs wrappers)`;
    }
    return result;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { unlinkSync(tmpFile); } catch { /* file may not exist if download failed */ }
  }
}

/** Pick the file extension the URL ends with — needed to pick the right
 *  extractor. Strips query strings (GitHub redirects to a signed URL
 *  with `?sp=…&sig=…` but the path component still ends correctly). */
function guessExtension(url: string): string {
  const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  for (const ext of [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".zip"]) {
    if (path.toLowerCase().endsWith(ext)) return ext;
  }
  return "";
}

/** Stream the URL body to disk. Uses fetch + the WHATWG → Node stream
 *  bridge so we can pipeline straight to a write stream — we don't want
 *  to buffer multi-MB tarballs in memory. Reports periodic byte totals
 *  via onProgress when Content-Length is known. */
async function downloadToFile(url: string, dest: string, onProgress?: (m: string) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? "0");
  if (!res.body) throw new Error("download returned empty body");

  let last = Date.now();
  let read = 0;
  const stream = (res.body as unknown as WebReadableStream<Uint8Array>);
  const node = Readable.fromWeb(stream);
  node.on("data", (chunk: Buffer) => {
    read += chunk.byteLength;
    // Throttle progress to 1Hz — every chunk would flood stderr.
    if (Date.now() - last > 1000 && onProgress) {
      last = Date.now();
      const pct = total ? `${Math.floor((read / total) * 100)}%` : "";
      onProgress(`  …${formatBytes(read)}${total ? `/${formatBytes(total)} ${pct}` : ""}`);
    }
  });
  await pipeline(node, createWriteStream(dest));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Extract `archive` into `dest`. Spawns the right cli for the format.
 *  Errors include the cli's stderr to make debugging easier — these
 *  failures are rare enough that "cryptic tar error in stderr" is much
 *  better than a swallowed generic "extract failed". */
function extractArchive(archive: string, dest: string, ext: string): Promise<void> {
  const isWin = process.platform === "win32";
  let cmd: string;
  let args: string[];
  if (ext === ".zip") {
    if (isWin) {
      // tar on Win10+ handles zip via -xf
      cmd = "tar"; args = ["-xf", archive, "-C", dest];
    } else {
      cmd = "unzip"; args = ["-q", "-o", archive, "-d", dest];
    }
  } else if (ext === ".tar.gz" || ext === ".tgz") {
    cmd = "tar"; args = ["-xzf", archive, "-C", dest];
  } else if (ext === ".tar.bz2" || ext === ".tbz2") {
    cmd = "tar"; args = ["-xjf", archive, "-C", dest];
  } else if (ext === ".tar.xz" || ext === ".txz") {
    cmd = "tar"; args = ["-xJf", archive, "-C", dest];
  } else {
    return Promise.reject(new Error(`unsupported archive extension '${ext || "?"}'`));
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => { err += d.toString(); });
    p.once("error", (e) => reject(new Error(`${cmd} spawn failed: ${e.message}`)));
    p.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(0, 400)}`));
    });
  });
}

/** Is `dir` a literal entry in $PATH? We don't resolve symlinks or do
 *  path comparison heuristics — if the user has the canonical
 *  ~/.local/bin in PATH (or a symlink resolving to it), it's there. */
function isOnPath(dir: string): boolean {
  const sep = process.platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "").split(sep).includes(dir);
}

// Re-export for the audit, which renders bin location hints.
export const wrappersDir = WRAPPERS_DIR;
export const binDir = BIN_DIR;
