/**
 * Agent Worker — per-environment session runtime.
 *
 * Each environment gets its own agent worker with a custom container image.
 * This worker exports SessionDO + Sandbox and routes incoming requests
 * from the main worker to the appropriate SessionDO instance.
 */

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

// --- Register harnesses ---
import { registerHarness } from "./harness/registry";
import { DefaultHarness } from "./harness/default-loop";
registerHarness("default", () => new DefaultHarness());

// --- Export DO classes (required by wrangler) ---
export { SessionDO } from "./runtime/session-do";
export { OmaSandbox as Sandbox } from "./oma-sandbox";

// --- Required by @cloudflare/sandbox 0.8.x outbound interception ---
export { ContainerProxy } from "@cloudflare/containers";

// --- Export outbound worker functions (legacy — see oma-sandbox.ts for the
// real handler wiring via @cloudflare/sandbox 0.8.x setOutboundHandler API). ---
export { outbound, outboundByHost } from "./outbound";

// --- HTTP app: thin router to SessionDO ---
const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", version: "2" }));

/**
 * POST /__internal/prepare-env — invoked by the main worker over the
 * service binding when an env with `image_strategy=base_snapshot` is
 * being created or its packages change. Runs the install + snapshot
 * inside this worker (which has the SANDBOX DO binding); returns the
 * adapter's `PrepareResult` for the main worker to persist.
 *
 * Auth: X-Internal-Token must match env.INTERNAL_TOKEN. Without that
 * the endpoint is a 403 — keeps anyone with the public service binding
 * from triggering arbitrary installs.
 *
 * Body: PrepareInput (env_id, tenant_id, config). Response: PrepareResult.
 */
/**
 * POST /__internal/prepare-env — fire-and-forget kickoff.
 *
 * Why this isn't a sync call:
 *   The CF Sandbox SDK's createBackup + multiple sequential exec calls
 *   would each be subrequests from this Worker handler. Once we return
 *   the 202 response, the isolate starts shutting down — sub-requests
 *   inside ctx.waitUntil get canceled (we observed mkdir succeeding
 *   then the 2nd sandbox call dying with status=Canceled).
 *
 *   Instead: write a SHELL SCRIPT that does the install end-to-end
 *   inside the container, fire it via startProcess() (detached, no
 *   container-side await), return 202. The sandbox container has its
 *   own runtime independent of any Worker isolate; the script runs to
 *   completion regardless of who's holding the originating request.
 *
 *   The cron tick (apps/main/src/index.ts scheduled()) polls building
 *   envs every minute, calls /__internal/prep-tick/:env_id below to
 *   check for the install.done marker and trigger the (single, fast)
 *   createBackup + callback once install finishes.
 */
app.post("/__internal/prepare-env", async (c) => {
  const expected = (c.env as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  const provided = c.req.header("x-internal-token");
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const { getSandbox: cfGetSandbox } = await import("@cloudflare/sandbox");
  const body = await c.req.json<{
    env_id: string;
    tenant_id: string;
    config: { packages?: Record<string, string[] | undefined> };
  }>();

  const cacheDir = `/home/env-cache/${body.env_id}`;
  const pkgs = body.config.packages ?? {};

  // apt rejection — same policy as before.
  if (pkgs.apt && pkgs.apt.length > 0) {
    return c.json({
      status: "error",
      error: `base_snapshot does not support apt packages (${pkgs.apt.join(", ")}). Either bake into the base image or switch to image_strategy: "dockerfile".`,
    });
  }

  const installScript = buildInstallScript(cacheDir, pkgs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = cfGetSandbox(c.env.SANDBOX as any, `prep-${body.env_id}`) as any;
  try {
    await sandbox.writeFile("/tmp/openma-prep.sh", installScript);
    await sandbox.startProcess("sh /tmp/openma-prep.sh");
  } catch (err) {
    // Kickoff failed — destroy the prep sandbox immediately so the
    // container slot doesn't leak. Without this, every transient
    // error here costs us a slot until CF eviction (which is opaque
    // and slow).
    try { await sandbox.destroy?.(); } catch { /* swallow */ }
    return c.json({
      status: "error",
      error: `kickoff failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return c.json({ status: "building", prep_session_id: `prep-${body.env_id}` }, 202);
});

/**
 * POST /__internal/prep-tick/:env_id — invoked by the main-worker cron.
 *
 * Cheap probe: is install.done present? If yes, run the (fast)
 * createBackup against the prep sandbox, POST the handle to the env's
 * /build-complete callback URL, and tear the sandbox down. If install
 * failed, surface the error the same way.
 *
 * Idempotent — multiple cron ticks landing on the same in-progress
 * env see install.notyet and no-op until completion.
 */
app.post("/__internal/prep-tick/:env_id", async (c) => {
  const expected = (c.env as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  const provided = c.req.header("x-internal-token");
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const envId = c.req.param("env_id");
  const callbackUrl = c.req.query("callback_url");
  if (!callbackUrl) return c.json({ error: "callback_url query required" }, 400);

  const { getSandbox: cfGetSandbox } = await import("@cloudflare/sandbox");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = cfGetSandbox(c.env.SANDBOX as any, `prep-${envId}`) as any;

  let probe: { exitCode: number; stdout: string; stderr: string };
  try {
    probe = await sandbox.exec(
      `if [ -f /home/env-cache/${envId}/install.done ]; then echo done; ` +
        `elif [ -f /home/env-cache/${envId}/install.failed ]; then ` +
        `echo failed; cat /home/env-cache/${envId}/install.failed; ` +
        `else echo notyet; fi`,
      { timeout: 30_000 },
    );
  } catch (err) {
    return c.json({ status: "tick_error", error: err instanceof Error ? err.message : String(err) });
  }

  const out = probe.stdout.trim();
  if (out.startsWith("notyet")) return c.json({ status: "still_building" });

  const internalToken = expected;
  if (out.startsWith("failed")) {
    const msg = out.substring("failed\n".length).slice(0, 1000) || "install failed (no detail)";
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({ status: "error", error: `install failed: ${msg}` }),
    }).catch(() => undefined);
    try { await sandbox.destroy?.(); } catch { /* ignore */ }
    return c.json({ status: "callback_sent_error" });
  }

  // out.startsWith("done") — finalize: createBackup + callback.
  const cacheDir = `/home/env-cache/${envId}`;
  let envVars: Record<string, string> = {};
  try {
    const envJson = await sandbox.readFile(`${cacheDir}/env.json`);
    envVars = JSON.parse(typeof envJson === "string" ? envJson : envJson.content);
  } catch (err) {
    return c.json({ status: "tick_error", error: `env.json read failed: ${err instanceof Error ? err.message : err}` });
  }

  let backup: { id: string; dir: string };
  try {
    backup = await sandbox.createBackup({
      dir: cacheDir,
      name: `env-${envId}`,
      ttl: 90 * 24 * 60 * 60,
    });
  } catch (err) {
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({ status: "error", error: `createBackup failed: ${err instanceof Error ? err.message : err}` }),
    }).catch(() => undefined);
    try { await sandbox.destroy?.(); } catch { /* ignore */ }
    return c.json({ status: "callback_sent_error" });
  }

  await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": internalToken },
    body: JSON.stringify({
      status: "ready",
      sandbox_worker_name: "sandbox-default",
      handle: { backup, env_vars: envVars, cache_dir: cacheDir, prepared_at: Date.now() },
    }),
  }).catch(() => undefined);

  try { await sandbox.destroy?.(); } catch { /* ignore */ }
  return c.json({ status: "callback_sent_ready" });
});

/**
 * GET /__internal/prep-debug/:env_id — read-only inspector for an
 * in-flight prep sandbox. Pulls the install log + filesystem state +
 * running processes so we can see what the container is actually
 * doing instead of guessing from outside silence.
 *
 * Auth: x-internal-token (same as the other internal endpoints).
 * Side effect: spins up the prep sandbox if it was evicted (one
 * exec is enough). Doesn't destroy.
 */
app.get("/__internal/prep-debug/:env_id", async (c) => {
  const expected = (c.env as { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  const provided = c.req.header("x-internal-token");
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const envId = c.req.param("env_id");
  const { getSandbox: cfGetSandbox } = await import("@cloudflare/sandbox");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox = cfGetSandbox(c.env.SANDBOX as any, `prep-${envId}`) as any;

  // Single composite exec keeps it one round-trip — multiple sandbox
  // calls in this handler would risk the same Canceled-mid-chain
  // pattern we already debugged.
  const cmd = [
    "echo '=== ls /home/env-cache/" + envId + " ==='",
    `ls -la /home/env-cache/${envId} 2>&1 || echo '(not found)'`,
    "echo '=== install.done | install.failed ==='",
    `[ -f /home/env-cache/${envId}/install.done ]   && echo 'done   YES' || echo 'done   NO'`,
    `[ -f /home/env-cache/${envId}/install.failed ] && echo 'failed YES' || echo 'failed NO'`,
    "echo '=== install.failed contents ==='",
    `[ -f /home/env-cache/${envId}/install.failed ] && cat /home/env-cache/${envId}/install.failed || echo '(no failure marker)'`,
    "echo '=== /tmp/openma-prep.log (last 4KB) ==='",
    `[ -f /tmp/openma-prep.log ] && tail -c 4096 /tmp/openma-prep.log || echo '(no log)'`,
    "echo '=== /tmp/openma-prep.sh ==='",
    `[ -f /tmp/openma-prep.sh ] && cat /tmp/openma-prep.sh || echo '(no script)'`,
    "echo '=== ps -e (running) ==='",
    `ps -e o pid,etime,comm 2>&1 | head -40`,
    "echo '=== uv / pip versions ==='",
    "which uv && uv --version 2>&1 || echo '(no uv)'",
  ].join(" && ");

  try {
    const result = await sandbox.exec(cmd, { timeout: 30_000 });
    return c.json({
      env_id: envId,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    return c.json({
      env_id: envId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Compose the shell script that installs all per-env packages into
 *  /home/env-cache/<env_id>/, writes env.json + activate.sh, and
 *  flips install.done | install.failed for the cron tick to read.
 *
 *  No `set -e` at the top — we want to capture the failing step's
 *  exit + stderr into install.failed even if it crashes. Wrapped in
 *  a subshell with explicit error trapping. */
function buildInstallScript(cacheDir: string, pkgs: Record<string, string[] | undefined>): string {
  const pip = pkgs.pip ?? [];
  const npm = pkgs.npm ?? [];
  const cargo = pkgs.cargo ?? [];
  const gem = pkgs.gem ?? [];
  const go = pkgs.go ?? [];
  const sh = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

  const steps: string[] = [
    `mkdir -p ${cacheDir} && chmod -R u+rw ${cacheDir}`,
  ];
  if (pip.length > 0) {
    steps.push(`uv venv ${cacheDir}/.venv --python 3.12`);
    steps.push(`uv pip install --python ${cacheDir}/.venv/bin/python ${pip.map(sh).join(" ")}`);
  }
  if (npm.length > 0) steps.push(`npm install --prefix ${cacheDir} --no-audit --no-fund ${npm.map(sh).join(" ")}`);
  if (cargo.length > 0) steps.push(`CARGO_HOME=${cacheDir}/.cargo cargo install ${cargo.map(sh).join(" ")}`);
  if (gem.length > 0) steps.push(`GEM_HOME=${cacheDir}/.gem gem install --no-document ${gem.map(sh).join(" ")}`);
  if (go.length > 0) steps.push(`GOPATH=${cacheDir}/.go go install ${go.map(sh).join(" ")}`);

  const envVarsJson = JSON.stringify({
    PATH: `${cacheDir}/.venv/bin:${cacheDir}/node_modules/.bin:${cacheDir}/.cargo/bin:${cacheDir}/.gem/bin:${cacheDir}/.go/bin:/usr/local/bin:/usr/bin:/bin`,
    VIRTUAL_ENV: `${cacheDir}/.venv`,
    NODE_PATH: `${cacheDir}/node_modules`,
    CARGO_HOME: `${cacheDir}/.cargo`,
    GEM_HOME: `${cacheDir}/.gem`,
    GOPATH: `${cacheDir}/.go`,
    PYTHONPATH: `${cacheDir}/.venv/lib/python3.12/site-packages`,
  });

  return [
    "#!/bin/sh",
    "set +e",
    "exec > /tmp/openma-prep.log 2>&1",
    "(",
    "  set -e",
    ...steps,
    `  cat > ${cacheDir}/env.json <<'OPENMA_ENV_JSON'`,
    envVarsJson,
    "OPENMA_ENV_JSON",
    `  cat > ${cacheDir}/activate.sh <<'OPENMA_ACTIVATE'`,
    "#!/bin/sh",
    "# Auto-generated by openma base_snapshot — source to activate this env.",
    `. ${cacheDir}/env.json.unused 2>/dev/null || true`,
    "OPENMA_ACTIVATE",
    `  touch ${cacheDir}/install.done`,
    ")",
    "rc=$?",
    `if [ $rc -ne 0 ]; then`,
    `  ( echo "exitcode=$rc"; tail -c 4096 /tmp/openma-prep.log ) > ${cacheDir}/install.failed`,
    "fi",
    "",
  ].join("\n");
}

app.all("/sessions/:id/*", async (c) => {
  const sessionId = c.req.param("id");
  const doId = c.env.SESSION_DO!.idFromName(sessionId);
  const doStub = c.env.SESSION_DO!.get(doId);
  // Workaround for cloudflare/workerd#2240: explicitly seed the partyserver
  // .name so internal getters don't throw during DO startup.
  (doStub as unknown as { setName?: (n: string) => void }).setName?.(sessionId);

  const url = new URL(c.req.url);
  const subPath = url.pathname.replace(`/sessions/${sessionId}`, "") || "/";
  const internalUrl = `http://internal${subPath}${url.search}`;

  return doStub.fetch(
    new Request(internalUrl, {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== "GET" && c.req.method !== "HEAD" ? c.req.raw.body : undefined,
    })
  );
});

export default app;
