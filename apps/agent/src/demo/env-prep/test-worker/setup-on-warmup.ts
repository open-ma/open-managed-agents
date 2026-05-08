// Setup-on-warmup — AMA-style lifecycle (no pre-build, no snapshot).
//
// Architecture:
//   env-create just stores the setup script in env config. No prep work.
//   When a session starts:
//     1. SDK provisions a fresh sandbox container
//     2. (optional) git clone the repo
//     3. Run the env's setup script (apt-get install ..., uv pip install ...)
//     4. Mark ready, hand off to agent code
//
//   The four steps mirror the AMA UI ticker:
//     ✓ Set up a cloud container
//     ✓ Cloned repository  (skipped if no git_repo)
//     ⏳ Running setup script
//     ⏳ Start Claude Code
//
// Why this beats snapshot:
//   - No SDK whitelist (createBackup only allows /workspace/home/tmp/var/tmp/app)
//   - Apt installs work transparently — they land in /usr like normal
//   - No R2, no presigned URLs, no D1 mirror, no GC
//   - Setup script changes take effect on next cold start (no rebuild)
//   - When container is warm (sleepAfter window), zero overhead — same as snapshot
//
// Cost: every cold start pays the install time. For language-level packages
// over a fast CF↔mirror network, this is typically <60s. Validated below.

import { Sandbox } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

const SETUP_KEY = "setup_state";
const HEARTBEAT_TICK_MS = 5_000;
// Two markers, two purposes:
//   /tmp/...        → warm-container marker. Tmpfs, gone on cold start.
//                     Match here = container is the SAME instance that ran
//                     setup → entire pipeline is a no-op.
//   /workspace/...  → cold-restart marker. Persists with main-line-2's
//                     /workspace backup. Match here = workspace was
//                     restored from backup, so all language-level packages
//                     (pip/npm/cargo/go in /workspace/.venv etc.) survived.
//                     Only need to re-run apt phase.
//
// On a fresh container (neither marker present) we run both phases.
const WARM_MARKER = "/tmp/.oma-setup-warm";
const RESTORED_MARKER = "/workspace/.oma-setup-restored";

export type SetupStep =
  | "container_starting"
  | "cloning_repo"
  | "running_setup"
  // Distinct step for cold-restart-after-workspace-restore. UI can render
  // this with a less alarming label ("Reinstalling system tools…")
  // because /workspace state already came back from backup — only apt
  // packages need re-download.
  | "reinstalling_apt"
  | "ready"
  | "failed";

export interface PackageList {
  apt?: string[];
  pip?: string[];
  npm?: string[];
  cargo?: string[];
  go?: string[];
}

export interface SetupConfig {
  /** Optional git repo to clone into /workspace before setup runs. */
  gitRepo?: { url: string; branch?: string };
  /**
   * Structured package list. Generates a setup script that installs apt
   * to /usr (lost on cold start) and pip/npm/cargo/go to /workspace
   * subdirs (kept by main-line-2 workspace backup).
   */
  packages?: PackageList;
  /**
   * Free-form setup script — escape hatch. Runs AFTER the structured
   * packages section. Use for one-off shell commands the package manager
   * lists can't express.
   */
  setupScript?: string;
  /** Disk usage cap (%) — fail-fast if setup pushes container over this. */
  diskCapPct?: number;
}

export type SetupState =
  | { status: "idle" }
  | {
      status: "running";
      step: SetupStep;
      startedAt: number;
      lastHeartbeatAt: number;
      stepStartedAt: number;
      stepDurations: Record<string, number>;
      config: SetupConfig;
    }
  | {
      status: "ready";
      readyAt: number;
      totalMs: number;
      stepDurations: Record<string, number>;
      config: SetupConfig;
    }
  | {
      status: "failed";
      failedAt: number;
      step: SetupStep;
      error: string;
      stepDurations: Record<string, number>;
      config: SetupConfig;
    };

interface ContainerEnv {
  SETUP_CONTAINER: DurableObjectNamespace;
}

interface OrchestratorEnv {
  SETUP_CONTAINER: DurableObjectNamespace;
}

const DISK_CAP_DEFAULT_PCT = 85;
const DISK_CAP_EXIT_CODE = 42;

// ---- The container host -------------------------------------------------

export class SetupContainer extends Sandbox<ContainerEnv> {
  override sleepAfter = "20m";
  override interceptHttps = false;

  /**
   * Run the full setup pipeline. Single RPC entry point — orchestrator
   * polls progress via the SetupOrchestrator (separate DO, doesn't share
   * mutex with this one).
   *
   * Each step writes back through `progressCb` so the orchestrator can
   * stream status to the UI. Returns the final state.
   */
  async runSetup(config: SetupConfig, sessionId: string): Promise<{
    ok: boolean;
    error?: string;
    finalStep: SetupStep;
    stepDurations: Record<string, number>;
    totalMs: number;
  }> {
    const totalStart = Date.now();
    const stepDurations: Record<string, number> = {};

    const recordStep = async (
      from: SetupStep | null,
      to: SetupStep,
    ): Promise<void> => {
      if (from) {
        stepDurations[from] = Date.now() - (this.lastStepStart ?? totalStart);
      }
      this.lastStepStart = Date.now();
      await this.publishStep(sessionId, to, stepDurations);
    };

    try {
      // Step 1 — container is already starting (this RPC arriving means
      // it's basically up). Mark and proceed.
      await recordStep(null, "container_starting");

      // Tiny readiness ping so we don't accidentally count network delay.
      await this.exec("true");

      // Step 2 — clone if requested.
      if (config.gitRepo) {
        await recordStep("container_starting", "cloning_repo");
        const branchArg = config.gitRepo.branch
          ? `-b ${shellQuote(config.gitRepo.branch)}`
          : "";
        const cloneCmd = `mkdir -p /workspace && cd /workspace && git clone --depth 1 ${branchArg} ${shellQuote(config.gitRepo.url)} repo 2>&1 | tail -20`;
        const r = await this.exec(cloneCmd);
        if (r.exitCode !== 0) {
          await recordStep("cloning_repo", "failed");
          return {
            ok: false,
            error: `clone_failed: ${(r.stderr || r.stdout || "").slice(-300)}`,
            finalStep: "cloning_repo",
            stepDurations,
            totalMs: Date.now() - totalStart,
          };
        }
      }

      // Step 3 — run setup script if any.
      const aptHash = aptHashOf(config);
      const langHash = langHashOf(config);
      const fullHash = configHash(config);
      const generated = buildSetupScript(config, { aptHash, langHash, fullHash });
      if (generated.script) {
        const prevStep = config.gitRepo ? "cloning_repo" : "container_starting";
        await recordStep(prevStep, "running_setup");
        const cap = config.diskCapPct ?? DISK_CAP_DEFAULT_PCT;
        const wrapped = `
          set +e
          ${generated.script}
          SETUP_EXIT=$?
          if [ $SETUP_EXIT -ne 0 ]; then exit $SETUP_EXIT; fi
          USED=$(df --output=used -BM / | tail -1 | tr -dc '0-9')
          TOTAL=$(df --output=size -BM / | tail -1 | tr -dc '0-9')
          PCT=$(( USED * 100 / TOTAL ))
          echo "[disk] ${'$'}{PCT}% used (${'$'}{USED}M / ${'$'}{TOTAL}M)"
          if [ ${'$'}PCT -gt ${cap} ]; then
            echo "[disk] over cap (${cap}%) — env too large"
            exit ${DISK_CAP_EXIT_CODE}
          fi
        `;
        const r = await this.exec(wrapped);
        if (r.exitCode === DISK_CAP_EXIT_CODE) {
          await recordStep("running_setup", "failed");
          return {
            ok: false,
            error: `disk_cap_exceeded: ${(r.stdout || "").slice(-300)}`,
            finalStep: "running_setup",
            stepDurations,
            totalMs: Date.now() - totalStart,
          };
        }
        if (r.exitCode !== 0) {
          await recordStep("running_setup", "failed");
          return {
            ok: false,
            error: `setup_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-500)}`,
            finalStep: "running_setup",
            stepDurations,
            totalMs: Date.now() - totalStart,
          };
        }
      }

      // Step 4 — done. Write BOTH markers so future ensureReady() calls can:
      //   - WARM_MARKER (/tmp): same container is hot, total no-op
      //   - RESTORED_MARKER (/workspace, in backup): cold container but
      //     workspace was restored, only re-run apt
      await this.exec(`echo "${fullHash}" > ${WARM_MARKER}; echo "${langHash}" > ${RESTORED_MARKER}`);
      const lastStep =
        generated.script ? "running_setup"
        : config.gitRepo ? "cloning_repo"
        : "container_starting";
      await recordStep(lastStep, "ready");

      return {
        ok: true,
        finalStep: "ready",
        stepDurations,
        totalMs: Date.now() - totalStart,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message ?? String(err),
        finalStep: "failed",
        stepDurations,
        totalMs: Date.now() - totalStart,
      };
    }
  }

  /** Test-only: arbitrary exec for diagnostics. */
  async diagExec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const r = await this.exec(cmd);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  /**
   * Restored-path apt-only re-install. Distinct from runSetup because:
   *
   *   - Only generates the apt section of the setup script (no
   *     pip/npm/cargo/go/git/setupScript re-runs — those came back from
   *     /workspace backup and re-running them would either be wasteful
   *     (pip skipping already-installed) or destructive (git clone
   *     erroring on existing dir).
   *   - Does NOT take the SetupConfig directly; only takes the apt list,
   *     so the caller (orchestrator) can keep the FULL config in DO state
   *     for UI display purposes.
   *   - Writes BOTH markers (warm + restored) with the FULL hashes
   *     supplied by the caller — restoring the same trust state as if
   *     full setup had run.
   */
  async runAptOnly(opts: {
    aptPackages: string[];
    fullHash: string;
    langHash: string;
    diskCapPct?: number;
    sessionId: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    durationMs: number;
  }> {
    const startMs = Date.now();
    try {
      // Tiny readiness ping (mirror runSetup's pattern).
      await this.exec("true");

      // Publish step transition for UI: container_starting → reinstalling_apt
      await this.publishStep(opts.sessionId, "reinstalling_apt", {});

      const apt = opts.aptPackages;
      const cap = opts.diskCapPct ?? DISK_CAP_DEFAULT_PCT;
      const aptScript = apt.length === 0
        ? `echo "[setup] no apt packages — restored path no-op"`
        : `apt-get update -qq && apt-get install -y -q --no-install-recommends ${apt.map(shellQuote).join(" ")}`;

      const wrapped = `
        set +e
        ${aptScript}
        SETUP_EXIT=$?
        if [ $SETUP_EXIT -ne 0 ]; then exit $SETUP_EXIT; fi
        USED=$(df --output=used -BM / | tail -1 | tr -dc '0-9')
        TOTAL=$(df --output=size -BM / | tail -1 | tr -dc '0-9')
        PCT=$(( USED * 100 / TOTAL ))
        echo "[disk] ${'$'}{PCT}% used (${'$'}{USED}M / ${'$'}{TOTAL}M)"
        if [ ${'$'}PCT -gt ${cap} ]; then exit ${DISK_CAP_EXIT_CODE}; fi
      `;
      const r = await this.exec(wrapped);
      if (r.exitCode === DISK_CAP_EXIT_CODE) {
        return { ok: false, error: `disk_cap_exceeded: ${(r.stdout || "").slice(-300)}`, durationMs: Date.now() - startMs };
      }
      if (r.exitCode !== 0) {
        return {
          ok: false,
          error: `apt_failed exit=${r.exitCode}: ${(r.stderr || r.stdout || "").slice(-500)}`,
          durationMs: Date.now() - startMs,
        };
      }

      // Refresh both markers with the FULL config hashes — caller
      // supplied them, so trust state == "everything has been applied".
      await this.exec(`echo "${opts.fullHash}" > ${WARM_MARKER}; echo "${opts.langHash}" > ${RESTORED_MARKER}`);
      return { ok: true, durationMs: Date.now() - startMs };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err), durationMs: Date.now() - startMs };
    }
  }

  /**
   * Probe THIS container for setup state. Three outcomes:
   *
   *   { state: "warm" }            — WARM_MARKER in /tmp matches full hash.
   *                                  Container is the same instance that
   *                                  ran setup. Total no-op.
   *   { state: "restored" }        — RESTORED_MARKER in /workspace matches
   *                                  langHash. Container is fresh but
   *                                  /workspace was restored from backup.
   *                                  Re-run apt-only.
   *   { state: "fresh", reason }   — Neither marker matches. Run full setup.
   *
   * Stable to container resets between calls — both `cat` reads tolerate
   * file-not-found cleanly.
   */
  async checkSetupMarker(opts: { fullHash: string; langHash: string }): Promise<
    | { state: "warm" }
    | { state: "restored" }
    | { state: "fresh"; reason: string }
  > {
    try {
      const r = await this.exec(
        `WARM=$(cat ${WARM_MARKER} 2>/dev/null || echo MISSING); ` +
        `REST=$(cat ${RESTORED_MARKER} 2>/dev/null || echo MISSING); ` +
        `echo "WARM=$WARM"; echo "REST=$REST"`
      );
      const out = r.stdout || "";
      const warm = (out.match(/WARM=(\S+)/)?.[1] ?? "MISSING").trim();
      const rest = (out.match(/REST=(\S+)/)?.[1] ?? "MISSING").trim();

      if (warm === opts.fullHash) return { state: "warm" };
      if (rest === opts.langHash) return { state: "restored" };
      return {
        state: "fresh",
        reason: `warm=${warm.slice(0, 12)} rest=${rest.slice(0, 12)} want fullH=${opts.fullHash} langH=${opts.langHash}`,
      };
    } catch (err) {
      return { state: "fresh", reason: `probe_error: ${(err as Error).message ?? err}` };
    }
  }

  override async onStop(...args: unknown[]): Promise<void> {
    const params = (args[0] ?? {}) as { exitCode?: number; reason?: string };
    console.log(
      `[setup-container] onStop exit=${params.exitCode ?? -1} reason=${params.reason ?? "?"}`,
    );
  }

  // ---- internal ----

  private lastStepStart: number | undefined;

  private async publishStep(
    sessionId: string,
    step: SetupStep,
    stepDurations: Record<string, number>,
  ): Promise<void> {
    const id = this.env.SETUP_CONTAINER.idFromName(`setup-orch:${sessionId}`);
    const orch = (this.env as unknown as { SETUP_ORCHESTRATOR: DurableObjectNamespace }).SETUP_ORCHESTRATOR;
    if (!orch) return;
    const stub = orch.get(orch.idFromName(`setup-orch:${sessionId}`)) as DurableObjectStub<SetupOrchestrator>;
    void id;
    try {
      await stub.publishStep(step, stepDurations);
    } catch {
      // best-effort
    }
  }
}

// ---- The orchestrator (state machine + UI poll surface) ----------------

export class SetupOrchestrator extends DurableObject<OrchestratorEnv & { SETUP_ORCHESTRATOR: DurableObjectNamespace }> {
  /**
   * Begin a session: kick off setup in container DO, return immediately.
   * Idempotent — calling again on the same DO while running returns the
   * current state.
   */
  async startSession(config: SetupConfig): Promise<{
    accepted: boolean;
    state: SetupState;
  }> {
    const cur = (await this.ctx.storage.get<SetupState>(SETUP_KEY)) ?? { status: "idle" as const };

    if (cur.status === "running") {
      return { accepted: false, state: cur };
    }
    if (cur.status === "ready") {
      // Re-running setup is meaningful (config changed) — caller decides.
      // For now we always restart on explicit startSession.
    }

    const sessionId = this.ctx.id.toString();
    const next: SetupState = {
      status: "running",
      step: "container_starting",
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      stepStartedAt: Date.now(),
      stepDurations: {},
      config,
    };
    await this.ctx.storage.put(SETUP_KEY, next);

    // Detached: orchestrator returns now, container call runs in waitUntil.
    const stub = this.containerStub(sessionId);
    this.ctx.waitUntil(this.runAndFinalize(stub, config));

    return { accepted: true, state: next };
  }

  async pollSession(): Promise<SetupState> {
    return (await this.ctx.storage.get<SetupState>(SETUP_KEY)) ?? { status: "idle" };
  }

  async resetSession(): Promise<void> {
    await this.ctx.storage.delete(SETUP_KEY);
  }

  /**
   * Per-message probe: caller (SessionDO.processUserMessage in production,
   * Hono /ensure-ready endpoint here) calls this BEFORE every user exec.
   *
   * Three paths:
   *   warm       — WARM_MARKER hit → no-op, ~30ms
   *   restored   — RESTORED_MARKER hit → re-run apt phase only (skip langs).
   *                Saves the typical pip+npm+cargo install time on cold
   *                restarts where /workspace was restored from backup.
   *   fresh      — neither marker → full setup (apt + langs + write markers).
   *
   * Returns the path taken so frontend can render appropriate progress UI:
   *   warm: no UI ticker
   *   restored: short "Reconnecting → installing system tools (5s)"
   *   fresh:    full AMA-style ticker (container start → setup → ready)
   */
  async ensureReady(config: SetupConfig): Promise<{
    path: "warm" | "restored" | "fresh";
    state: SetupState;
    detectionMs: number;
  }> {
    const detectStart = Date.now();
    const fullHash = configHash(config);
    const langHash = langHashOf(config);
    const stub = this.containerStub(this.ctx.id.toString());

    let probe: Awaited<ReturnType<SetupContainer["checkSetupMarker"]>>;
    try {
      probe = await stub.checkSetupMarker({ fullHash, langHash });
    } catch (err) {
      probe = { state: "fresh", reason: `probe_throw: ${(err as Error).message ?? err}` };
    }
    const detectionMs = Date.now() - detectStart;

    if (probe.state === "warm") {
      const cur = (await this.ctx.storage.get<SetupState>(SETUP_KEY)) ?? { status: "idle" as const };
      return { path: "warm", state: cur, detectionMs };
    }

    if (probe.state === "restored") {
      console.log(
        `[orchestrator] ensureReady: workspace restored, re-running apt-only`,
      );
      // Set state to "running" with FULL config (so UI shows the right
      // config) and the distinct "reinstalling_apt" step (so UI can
      // render with a less alarming message). Don't go through
      // startSession — that would clobber state.config to apt-only.
      const sessionId = this.ctx.id.toString();
      const startedAt = Date.now();
      const stepDurations: Record<string, number> = {
        container_starting: 0, // no actual container start (it's already up post-restore)
      };
      const running: SetupState = {
        status: "running",
        step: "reinstalling_apt",
        startedAt,
        lastHeartbeatAt: startedAt,
        stepStartedAt: startedAt,
        stepDurations,
        config, // FULL original config (not apt-only)
      };
      await this.ctx.storage.put(SETUP_KEY, running);

      const result = await stub.runAptOnly({
        aptPackages: config.packages?.apt ?? [],
        fullHash,
        langHash,
        diskCapPct: config.diskCapPct,
        sessionId,
      });

      const totalMs = result.durationMs;
      stepDurations.reinstalling_apt = totalMs;

      const nextState: SetupState = result.ok
        ? {
            status: "ready",
            readyAt: Date.now(),
            totalMs,
            stepDurations,
            config, // FULL config preserved
          }
        : {
            status: "failed",
            failedAt: Date.now(),
            step: "reinstalling_apt",
            error: result.error ?? "unknown",
            stepDurations,
            config,
          };
      await this.ctx.storage.put(SETUP_KEY, nextState);
      return { path: "restored", state: nextState, detectionMs };
    }

    console.log(
      `[orchestrator] ensureReady: marker missing (${probe.reason}), running full setup`,
    );
    const result = await this.startSession(config);
    return { path: "fresh", state: result.state, detectionMs };
  }

  /** Called by the container to publish progress. Updates DO storage. */
  async publishStep(step: SetupStep, stepDurations: Record<string, number>): Promise<void> {
    const cur = await this.ctx.storage.get<SetupState>(SETUP_KEY);
    if (!cur || cur.status !== "running") return;
    cur.step = step;
    cur.stepStartedAt = Date.now();
    cur.lastHeartbeatAt = Date.now();
    cur.stepDurations = stepDurations;
    await this.ctx.storage.put(SETUP_KEY, cur);
  }

  /** Diagnostic exec — proxies to the container DO. */
  async diagExec(cmd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const stub = this.containerStub(this.ctx.id.toString());
    return stub.diagExec(cmd);
  }

  // ---- internal ----

  private async runAndFinalize(stub: DurableObjectStub<SetupContainer>, config: SetupConfig): Promise<void> {
    const sessionId = this.ctx.id.toString();
    let result: Awaited<ReturnType<SetupContainer["runSetup"]>>;
    try {
      result = await stub.runSetup(config, sessionId);
    } catch (err) {
      result = {
        ok: false,
        error: (err as Error).message ?? String(err),
        finalStep: "failed",
        stepDurations: {},
        totalMs: 0,
      };
    }

    if (result.ok) {
      const ready: SetupState = {
        status: "ready",
        readyAt: Date.now(),
        totalMs: result.totalMs,
        stepDurations: result.stepDurations,
        config,
      };
      await this.ctx.storage.put(SETUP_KEY, ready);
    } else {
      const failed: SetupState = {
        status: "failed",
        failedAt: Date.now(),
        step: result.finalStep,
        error: result.error ?? "unknown",
        stepDurations: result.stepDurations,
        config,
      };
      await this.ctx.storage.put(SETUP_KEY, failed);
    }
  }

  private containerStub(sessionId: string): DurableObjectStub<SetupContainer> {
    const id = this.env.SETUP_CONTAINER.idFromName(`setup-container:${sessionId}`);
    return this.env.SETUP_CONTAINER.get(id) as DurableObjectStub<SetupContainer>;
  }
}

// ---- helpers ----

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteList(items: string[] | undefined): string {
  if (!items || items.length === 0) return "";
  return items.map(shellQuote).join(" ");
}

/**
 * Generate a setup script from structured packages + free-form snippet.
 *
 * Apt installs to /usr (lost on cold start, re-run on `restored` path).
 * Pip/npm/cargo/go install to /workspace/.<lang> subdirs (kept by main-
 * line-2 backup, so they survive cold restart).
 *
 * The ${PATH_PREAMBLE} sets PATH+CARGO_HOME+GOPATH so subsequent commands
 * (and the agent's own subprocesses, if it sources /workspace/.oma-env)
 * find the binaries.
 *
 * Skipped sections short-circuit so a no-package-no-script SetupConfig
 * generates an empty script (the caller skips the "running_setup" step
 * entirely in that case).
 */
function buildSetupScript(
  config: SetupConfig,
  hashes: { aptHash: string; langHash: string; fullHash: string },
): { script: string } {
  const apt = config.packages?.apt ?? [];
  const pip = config.packages?.pip ?? [];
  const npm = config.packages?.npm ?? [];
  const cargo = config.packages?.cargo ?? [];
  const go = config.packages?.go ?? [];
  const free = config.setupScript ?? "";

  const sections: string[] = [];

  if (apt.length > 0) {
    // apt-get is idempotent — already-installed packages exit fast (no
    // re-download). On `restored` path this is the only thing we re-run.
    sections.push(`# --- apt ---
echo "[setup] apt: ${apt.join(", ")}"
apt-get update -qq
apt-get install -y -q --no-install-recommends ${shellQuoteList(apt)}`);
  }

  if (pip.length > 0) {
    sections.push(`# --- pip → /workspace/.venv ---
echo "[setup] pip: ${pip.join(", ")}"
mkdir -p /workspace
[ -d /workspace/.venv ] || uv venv /workspace/.venv
uv pip install --python /workspace/.venv/bin/python -q ${shellQuoteList(pip)}`);
  }

  if (npm.length > 0) {
    sections.push(`# --- npm → /workspace/.npm-global ---
echo "[setup] npm: ${npm.join(", ")}"
mkdir -p /workspace/.npm-global
npm config set prefix /workspace/.npm-global
npm install -g --silent ${shellQuoteList(npm)}`);
  }

  if (cargo.length > 0) {
    sections.push(`# --- cargo → /workspace/.cargo ---
echo "[setup] cargo: ${cargo.join(", ")}"
export CARGO_HOME=/workspace/.cargo
mkdir -p $CARGO_HOME
cargo install --quiet ${shellQuoteList(cargo)}`);
  }

  if (go.length > 0) {
    sections.push(`# --- go → /workspace/.go ---
echo "[setup] go: ${go.join(", ")}"
export GOPATH=/workspace/.go GOMODCACHE=/workspace/.go/pkg/mod GOBIN=/workspace/.go/bin
mkdir -p $GOBIN
${go.map((pkg) => `go install ${shellQuote(pkg)}`).join("\n")}`);
  }

  if (free.trim()) {
    sections.push(`# --- free-form setupScript ---
${free}`);
  }

  if (sections.length === 0) {
    return { script: "" };
  }

  // Emit a /workspace/.oma-env file so caller can `source` it from agent
  // shell to get correct PATH for installed binaries.
  const omaEnv = `# --- write /workspace/.oma-env (PATH for installed langs) ---
mkdir -p /workspace
cat > /workspace/.oma-env <<'EOF'
export PATH=/workspace/.venv/bin:/workspace/.npm-global/bin:/workspace/.cargo/bin:/workspace/.go/bin:$PATH
export CARGO_HOME=/workspace/.cargo
export GOPATH=/workspace/.go
export GOMODCACHE=/workspace/.go/pkg/mod
EOF
echo "[setup] wrote /workspace/.oma-env"`;
  sections.push(omaEnv);

  void hashes; // hashes are written to markers by the caller, not here
  return { script: sections.join("\n\n") };
}

/**
 * Hash of just the apt section. Used by the restored-path apt-only setup.
 */
function aptHashOf(config: SetupConfig): string {
  return fnv1a(JSON.stringify({ apt: config.packages?.apt ?? [] }));
}

/**
 * Hash of everything that lives in /workspace and would survive backup.
 * Includes language packages (pip/npm/cargo/go all install to
 * /workspace/.<lang>), git repo (cloned into /workspace), and the
 * free-form setupScript (which a user might use to write files anywhere
 * — we conservatively assume it touches /workspace).
 *
 * Mismatch on this hash → /workspace contents are stale → must run full
 * setup, not the restored-path apt-only.
 */
function langHashOf(config: SetupConfig): string {
  return fnv1a(JSON.stringify({
    pip: config.packages?.pip ?? [],
    npm: config.packages?.npm ?? [],
    cargo: config.packages?.cargo ?? [],
    go: config.packages?.go ?? [],
    git: config.gitRepo ?? null,
    setupScript: config.setupScript ?? "",
  }));
}

/**
 * Stable hash of a SetupConfig. Used as the marker payload so that if
 * the user's setup script CHANGES (e.g. they added a new pip dep), the
 * next ensureReady() detects "hash mismatch" and re-runs even if the
 * old container is still warm.
 */
function configHash(config: SetupConfig): string {
  return fnv1a(JSON.stringify({
    git: config.gitRepo ?? null,
    packages: config.packages ?? null,
    setup: config.setupScript ?? null,
    diskCap: config.diskCapPct ?? null,
  }));
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
