// Setup-on-warmup integration for SessionDO. Replaces the dumb
// "install everything every cold start" loop in SessionDO.doWarmUpSandbox
// (lines 1860-1880) with a marker-aware 3-path flow:
//
//   warm     → markers in /tmp + /workspace match → no-op
//   restored → /tmp marker gone but /workspace marker survived backup
//              → only re-install apt (lang packages already in /workspace
//              came back via main-line-2 workspace restore)
//   fresh    → both markers gone → full setup
//
// Lang packages (pip/npm/cargo/go) are redirected to /workspace/.<lang>/
// so they're captured by the existing /workspace backup. Apt installs to
// /usr (system dirs) which can't be backed up via SDK whitelist — accepted
// cost on cold restart.
//
// Demo + benchmarks: apps/agent/src/demo/env-prep/test-worker (worktree).
//
// Migration history:
//   - SessionDO previously ran inline `pip install` etc. as plain shell on
//     every cold start (~30-60s wasted).
//   - GitHub-CI base_snapshot path was tried + reverted (commit 02d7d2d).
//   - This module is the third design (after lazy-snapshot + per-DO-prep
//     attempts), validated against AMA's setup-script pattern.

interface PackageList {
  pip?: string[];
  npm?: string[];
  apt?: string[];
  cargo?: string[];
  gem?: string[];   // accepted in input but skipped in output (no ruby in sandbox-base)
  go?: string[];
}

const WARM_MARKER = "/tmp/.oma-setup-warm";
const RESTORED_MARKER = "/workspace/.oma-setup-restored";

/**
 * Wrapped exec result. SessionDO's CloudflareSandbox.exec returns a
 * single string formatted as "exit=N\n<stdout>\nstderr: <stderr>" — we
 * parse it back into structured form.
 */
interface ExecLike {
  (cmd: string, timeout?: number): Promise<string>;
}

function parseExec(raw: string): { exitCode: number; stdout: string; stderr: string } {
  const m = raw.match(/^exit=(-?\d+)\n?/);
  const exitCode = m ? parseInt(m[1], 10) : -1;
  const rest = m ? raw.slice(m[0].length) : raw;
  const stderrMarker = "\nstderr: ";
  const idx = rest.indexOf(stderrMarker);
  if (idx >= 0) {
    return { exitCode, stdout: rest.slice(0, idx), stderr: rest.slice(idx + stderrMarker.length) };
  }
  return { exitCode, stdout: rest, stderr: "" };
}

/**
 * Probe THIS container's setup state. Returns:
 *   "warm"     — same instance that ran setup, total no-op
 *   "restored" — fresh container, /workspace restored from backup; re-apt
 *   "fresh"    — neither marker matches; run full setup
 */
async function probeSetupState(
  exec: ExecLike,
  fullHash: string,
  langHash: string,
): Promise<"warm" | "restored" | "fresh"> {
  try {
    const raw = await exec(
      `WARM=$(cat ${WARM_MARKER} 2>/dev/null || echo MISSING); ` +
      `REST=$(cat ${RESTORED_MARKER} 2>/dev/null || echo MISSING); ` +
      `echo "WARM=$WARM"; echo "REST=$REST"`,
      15_000,
    );
    const { stdout } = parseExec(raw);
    const warm = (stdout.match(/WARM=(\S+)/)?.[1] ?? "MISSING").trim();
    const rest = (stdout.match(/REST=(\S+)/)?.[1] ?? "MISSING").trim();
    if (warm === fullHash) return "warm";
    if (rest === langHash) return "restored";
    return "fresh";
  } catch {
    return "fresh";
  }
}

/** Generate the apt-only install script. Empty string if no apt packages. */
function buildAptScript(apt: string[] | undefined): string {
  if (!apt || apt.length === 0) return "";
  return `apt-get update -qq && apt-get install -y -qq --no-install-recommends ${apt.map(shellQuote).join(" ")}`;
}

/**
 * Generate the full setup script (apt + langs to /workspace).
 *
 * Lang sections write to:
 *   pip   → /workspace/.venv (via uv venv + uv pip install --python)
 *   npm   → /workspace/.npm-global (via npm config set prefix)
 *   cargo → /workspace/.cargo (CARGO_HOME)
 *   go    → /workspace/.go (GOPATH/GOBIN)
 *
 * Also writes /workspace/.oma-env so callers can `source` it for PATH.
 */
function buildFullSetupScript(packages: PackageList | undefined): string {
  if (!packages) return "";
  const sections: string[] = [];

  const apt = buildAptScript(packages.apt);
  if (apt) sections.push(apt);

  const pip = packages.pip ?? [];
  if (pip.length > 0) {
    sections.push(
      `mkdir -p /workspace`,
      `[ -d /workspace/.venv ] || uv venv /workspace/.venv`,
      `uv pip install --python /workspace/.venv/bin/python -q ${pip.map(shellQuote).join(" ")}`,
    );
  }

  const npm = packages.npm ?? [];
  if (npm.length > 0) {
    sections.push(
      `mkdir -p /workspace/.npm-global`,
      `npm config set prefix /workspace/.npm-global`,
      `npm install -g --silent ${npm.map(shellQuote).join(" ")}`,
    );
  }

  const cargo = packages.cargo ?? [];
  if (cargo.length > 0) {
    sections.push(
      `export CARGO_HOME=/workspace/.cargo`,
      `mkdir -p $CARGO_HOME`,
      `cargo install --quiet ${cargo.map(shellQuote).join(" ")}`,
    );
  }

  const go = packages.go ?? [];
  if (go.length > 0) {
    sections.push(
      `export GOPATH=/workspace/.go GOMODCACHE=/workspace/.go/pkg/mod GOBIN=/workspace/.go/bin`,
      `mkdir -p $GOBIN`,
      ...go.map((pkg) => `go install ${shellQuote(pkg)}`),
    );
  }

  if (sections.length === 0) return "";

  // Always emit /workspace/.oma-env so the agent shell can source it.
  sections.push(
    `cat > /workspace/.oma-env <<'EOF'`,
    `export PATH=/workspace/.venv/bin:/workspace/.npm-global/bin:/workspace/.cargo/bin:/workspace/.go/bin:$PATH`,
    `export CARGO_HOME=/workspace/.cargo`,
    `export GOPATH=/workspace/.go`,
    `export GOMODCACHE=/workspace/.go/pkg/mod`,
    `EOF`,
  );

  return sections.join("\n");
}

/**
 * Hash of just the lang section (anything that lives in /workspace and
 * survives backup). Used by the RESTORED_MARKER for the "/workspace
 * restored, only re-apt" optimization.
 */
function langHash(packages: PackageList | undefined): string {
  return fnv1a(JSON.stringify({
    pip: packages?.pip ?? [],
    npm: packages?.npm ?? [],
    cargo: packages?.cargo ?? [],
    go: packages?.go ?? [],
  }));
}

/**
 * Hash of the full config (apt + langs). Used by WARM_MARKER for the
 * "same container, no work needed" fast path.
 */
function fullHash(packages: PackageList | undefined): string {
  return fnv1a(JSON.stringify({
    apt: packages?.apt ?? [],
    pip: packages?.pip ?? [],
    npm: packages?.npm ?? [],
    cargo: packages?.cargo ?? [],
    go: packages?.go ?? [],
  }));
}

/**
 * Main entry point. Replaces SessionDO's inline package install loop.
 *
 * Called from doWarmUpSandbox AFTER container is ready AND workspace
 * backup has been restored.
 *
 * onProgress lets the caller emit step events to its own observers
 * (event log, frontend SSE). Step names align with the demo:
 *   - "running_setup"      for fresh path
 *   - "reinstalling_apt"   for restored path (less alarming label)
 */
export async function ensureSetupApplied(
  sandbox: { exec: ExecLike },
  packages: PackageList | undefined,
  onProgress?: (event: { kind: "step"; step: "running_setup" | "reinstalling_apt"; reason?: string } | { kind: "done"; path: "warm" | "restored" | "fresh"; durationMs: number }) => void,
): Promise<{ path: "warm" | "restored" | "fresh"; durationMs: number; error?: string }> {
  const startMs = Date.now();
  const fHash = fullHash(packages);
  const lHash = langHash(packages);

  const state = await probeSetupState(sandbox.exec, fHash, lHash);

  if (state === "warm") {
    onProgress?.({ kind: "done", path: "warm", durationMs: Date.now() - startMs });
    return { path: "warm", durationMs: Date.now() - startMs };
  }

  if (state === "restored") {
    onProgress?.({ kind: "step", step: "reinstalling_apt" });
    const aptScript = buildAptScript(packages?.apt);
    if (aptScript) {
      const raw = await sandbox.exec(`set +e; ${aptScript}`, 180_000);
      const r = parseExec(raw);
      if (r.exitCode !== 0) {
        return {
          path: "restored",
          durationMs: Date.now() - startMs,
          error: `apt_install_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-300)}`,
        };
      }
    }
    await sandbox.exec(
      `echo "${fHash}" > ${WARM_MARKER}; echo "${lHash}" > ${RESTORED_MARKER}`,
    );
    onProgress?.({ kind: "done", path: "restored", durationMs: Date.now() - startMs });
    return { path: "restored", durationMs: Date.now() - startMs };
  }

  // fresh
  onProgress?.({ kind: "step", step: "running_setup" });
  const fullScript = buildFullSetupScript(packages);
  if (fullScript) {
    const raw = await sandbox.exec(`set +e; ${fullScript}`, 600_000);
    const r = parseExec(raw);
    if (r.exitCode !== 0) {
      return {
        path: "fresh",
        durationMs: Date.now() - startMs,
        error: `full_setup_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-300)}`,
      };
    }
  }
  await sandbox.exec(
    `echo "${fHash}" > ${WARM_MARKER}; echo "${lHash}" > ${RESTORED_MARKER}`,
  );
  onProgress?.({ kind: "done", path: "fresh", durationMs: Date.now() - startMs });
  return { path: "fresh", durationMs: Date.now() - startMs };
}

// ---- helpers ----

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
