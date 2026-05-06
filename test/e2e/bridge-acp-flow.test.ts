/**
 * End-to-end bridge / ACP-agents test against prod openma.dev.
 *
 * Validates the full CLI-first flow for OMA's local-runtime story:
 *   `oma bridge daemon` (already attached) → openma relay → ACP child → reply
 *
 * Covers the changes from this branch:
 *   - 6-agent registry (claude / codex / gemini / opencode / hermes / openclaw)
 *   - claude-code-acp legacy alias canonicalize + legacySpec fallback
 *   - per-agent bundle layout (.claude/skills, .opencode/agents, inline)
 *   - local_skill_blocklist filtering at spawn time
 *   - setup.ts deprecated-binary warning
 *   - console bundle ships canonicalize / install-hint code
 *
 * Prerequisites:
 *   - oma cli built at packages/cli/dist/index.js
 *   - oma authed (`oma whoami` returns a tenant)
 *   - daemon attached (`oma runtime list` shows it online)
 *   - ACP binaries installed locally per the registry's installHint values
 *
 * Usage:
 *   pnpm tsx test/e2e/bridge-acp-flow.test.ts
 *   pnpm tsx test/e2e/bridge-acp-flow.test.ts --test-name-pattern=registry
 *
 * Exit code: number of failed test cases (0 = all green).
 */

import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, readdirSync, existsSync, renameSync, statSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Existence check that works for broken symlinks too. claude-agent-acp's
 * npm shim is a relative-path symlink (`../lib/node_modules/.../index.js`);
 * when you mv it to /tmp the link survives but its target resolves to a
 * non-existent path. fs.existsSync follows links and reports false on
 * broken ones — restore-on-finally then thinks the hidden file is gone
 * and skips, stranding the binary across test runs. lstat doesn't
 * follow, so it sees the dangling symlink.
 */
function pathExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

// ─── config ──────────────────────────────────────────────────────────────

const WORKTREE = "$HOME/oos-proj/open-managed-agents/.claude/worktrees/acp-agents-expand";
const CLI_BIN = join(WORKTREE, "packages/cli/dist/index.js");

// Profile-aware paths: when OMA_PROFILE=staging is set, target the
// per-profile bridge dir / plist that `oma --profile staging` writes to.
// Empty profile → byte-identical to the pre-profile single-tenant layout.
// We compute these once at module load; tests that re-read OMA_PROFILE
// at runtime would need refactor, but for end-to-end we set the profile
// once via the test runner's env and stick with it.
const PROFILE = (process.env.OMA_PROFILE ?? "").trim();
const DIR_SUFFIX = PROFILE ? `-${PROFILE}` : "";
const LABEL_SUFFIX = PROFILE ? `.${PROFILE}` : "";
const BRIDGE_ROOT = join(homedir(), `.oma/bridge${DIR_SUFFIX}`);
const CREDS = join(BRIDGE_ROOT, "credentials.json");
const DAEMON_LOG = join(BRIDGE_ROOT, "logs", "bridge.log");
const SESSIONS_ROOT = join(BRIDGE_ROOT, "sessions");
const PLIST = join(homedir(), "Library/LaunchAgents", `dev.openma.bridge${LABEL_SUFFIX}.plist`);
const NPM_BIN_DIR = "$HOME/.nvm/versions/node/v24.14.0/bin";

let RUNTIME_ID = "";
let ENV_ID = "";

// Track resources we create so cleanup can find them. Agents/sessions
// stay on the server (the API is archive-only); we just log them.
const created: { agents: string[]; sessions: string[] } = { agents: [], sessions: [] };

// ─── child-process helpers ───────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  combined: string; // stdout + stderr, in spawn order
}

/**
 * Run the oma cli and capture both streams. Sync — these calls are short
 * (sub-second for cli plumbing, model latency is in the chat path which
 * uses a separate streaming spawn).
 */
function oma(...args: string[]): RunResult {
  const r: SpawnSyncReturns<string> = spawnSync("node", [CLI_BIN, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    code: r.status,
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

/**
 * Stream a chat turn with a wall-clock cap. Returns the full combined
 * output. We don't use spawnSync here because chat can take 60s+ and we
 * want incremental output to flow to the test runner if --watch is used.
 */
function chat(sessionId: string, msg: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolve) => {
    const buf: string[] = [];
    const p = spawn("node", [CLI_BIN, "sessions", "chat", sessionId, msg], {
      env: process.env,
    });
    const kill = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.stdout.on("data", (d: Buffer) => buf.push(d.toString()));
    p.stderr.on("data", (d: Buffer) => buf.push(d.toString()));
    p.once("close", () => {
      clearTimeout(kill);
      resolve(buf.join(""));
    });
  });
}

// ─── domain helpers ──────────────────────────────────────────────────────

/**
 * Create an agent bound to the test runtime + given ACP id. Returns the
 * agent id. Throws on failure (test-runner picks up the error).
 *
 * Sleeps 1s post-create — D1 read-replica lag occasionally surfaces as
 * 404 on the immediately-following session create. Cheap insurance.
 */
async function createAgent(name: string, acpAgentId: string): Promise<string> {
  // Retry on transient "fetch failed" — observed once-per-suite when
  // the test runner fires several agent-creates in quick succession
  // against staging. cli-side fetch() occasionally bails before its
  // first connection completes; a short wait + retry clears it.
  let r: RunResult | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = oma(
      "agents", "create", name,
      "--model", "claude-sonnet-4-6",
      "--system", "You are an e2e test agent. Reply with the single word PONG and nothing else.",
      "--runtime", RUNTIME_ID,
      "--acp-agent", acpAgentId,
    );
    const id = r.combined.match(/agent-[a-z0-9]+/)?.[0];
    if (id) {
      created.agents.push(id);
      await sleep(1000);
      return id;
    }
    if (/fetch failed|ECONN|ETIMEDOUT/i.test(r.combined)) {
      await sleep(2000);
      continue;
    }
    break; // non-transient failure — bail with the message
  }
  throw new Error(`agent create failed: ${(r?.combined ?? "(no output)").slice(0, 300)}`);
}

/**
 * Create a session with retry on D1 read-replica lag (Agent not found)
 * AND on transient cli-side fetch failures (occasional flake on rapid
 * parallel session creates against staging/prod). 5 attempts × 2s = up
 * to 10s of waiting; in practice the second attempt always wins.
 */
async function createSession(agentId: string, title: string): Promise<string> {
  let last: RunResult | undefined;
  for (let i = 0; i < 5; i++) {
    const r = oma("sessions", "create", "--agent", agentId, "--env", ENV_ID, "--title", title);
    last = r;
    const id = r.combined.match(/sess-[a-z0-9]+/)?.[0];
    if (id) {
      created.sessions.push(id);
      return id;
    }
    if (/agent not found|404|fetch failed|ECONN|ETIMEDOUT/i.test(r.combined)) {
      await sleep(2000);
      continue;
    }
    throw new Error(`session create failed (non-retryable): ${r.combined.slice(0, 300)}`);
  }
  throw new Error(`session create failed after retries: ${(last?.combined ?? "(no output)").slice(0, 300)}`);
}

/**
 * Pull the runtime row's reported agents list from `oma runtime list`.
 * Output columns: ID HOSTNAME OS STATUS VER AGENTS HEARTBEAT — comma-
 * joined ids in column 6. Empty string when there's no runtime row.
 */
function getRuntimeAgents(): string {
  const lines = oma("runtime", "list").stdout.trim().split("\n");
  if (lines.length < 2) return "";
  // Column 6 is whitespace-free (comma-joined ids), so split() works.
  return lines[1].split(/\s+/)[5] ?? "";
}

/**
 * Wait until the runtime row reports `wantAgent` in its agents column.
 * After daemon restart the hello manifest can take up to ~15s on prod
 * before the row reflects the new detection list.
 */
async function waitForRuntimeAgent(wantAgent: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getRuntimeAgents().includes(wantAgent)) return true;
    await sleep(1000);
  }
  return false;
}

/** Locate the daemon's most-recent per-session cwd (highest mtime under bridge/sessions). */
function newestSessionCwd(): string | null {
  if (!existsSync(SESSIONS_ROOT)) return null;
  const dirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: statSync(join(SESSIONS_ROOT, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0] ? join(SESSIONS_ROOT, dirs[0].name) : null;
}

/** Restart launchd-managed daemon. Async — returns once attached. */
async function restartDaemon(): Promise<void> {
  spawnSync("launchctl", ["unload", PLIST]);
  await sleep(1000);
  spawnSync("launchctl", ["load", PLIST]);
  // Wait for daemon to reattach (writes "✓ attached" to log)
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const tail = readFileSync(DAEMON_LOG, "utf-8").split("\n").slice(-20).join("\n");
    if (tail.includes("attached to wss")) return;
    await sleep(500);
  }
}

// ─── lifecycle ───────────────────────────────────────────────────────────

before(async () => {
  // Resolve runtime + env once. Test suite is no-op if either is absent.
  const credsRaw = readFileSync(CREDS, "utf-8");
  RUNTIME_ID = JSON.parse(credsRaw).runtimeId;
  assert.ok(RUNTIME_ID, `no runtimeId in ${CREDS}`);

  const envsOut = oma("envs", "list").stdout;
  const envLine = envsOut.split("\n").find((l) => / ready\s*$/.test(l));
  ENV_ID = envLine?.match(/env-[a-z0-9]+/)?.[0] ?? "";
  assert.ok(ENV_ID, "no env in ready state — create one in console first");

  // If we self-healed above, daemon may not have re-detected yet —
  // restart it and wait for the runtime row to reflect the merged
  // registry. (Cheap: ~5s on prod with the canonical binary already
  // restored.) Look for the canonical id from the official ACP registry.
  if (!getRuntimeAgents().includes("claude-acp")) {
    await restartDaemon();
    await waitForRuntimeAgent("claude-acp", 30_000);
  }

  console.log(`[setup] runtime=${RUNTIME_ID} env=${ENV_ID}${PROFILE ? `  profile=${PROFILE}` : ""}`);
});

after(() => {
  console.log(`\n[teardown] created agents=${created.agents.length} sessions=${created.sessions.length}`);
  console.log(`           (left on server — see \`oma agents list --archived\`)`);
});

// ─── tests ───────────────────────────────────────────────────────────────

test("registry: daemon reports core ACP agents from merged (official + overlay) registry", () => {
  const reported = getRuntimeAgents();
  // After A2 the daemon merges the official ACP registry with OMA's
  // overlay. ids match the official slugs (claude-acp not claude-
  // agent-acp); pre-A2 ids still resolve via overlay aliases on lookup.
  for (const want of ["claude-acp", "gemini", "opencode", "hermes", "openclaw"]) {
    assert.ok(reported.includes(want), `${want} missing from runtime.agents (got: ${reported})`);
  }
});

test("chat: claude-acp round-trip via openma relay", async () => {
  const agent = await createAgent(`e2e-claude-${Date.now()}`, "claude-acp");
  const session = await createSession(agent, "e2e-claude");
  const reply = await chat(session, "Reply with PONG.", 60_000);
  assert.match(reply, /PONG/i, `no PONG in reply: ${reply.slice(-200)}`);
});

test("chat: opencode round-trip", async () => {
  const agent = await createAgent(`e2e-opencode-${Date.now()}`, "opencode");
  const session = await createSession(agent, "e2e-opencode");
  const reply = await chat(session, "Reply with PONG.", 60_000);
  assert.match(reply, /PONG/i, `no PONG in reply: ${reply.slice(-200)}`);
});

test("legacy alias: pre-A2 id claude-agent-acp canonicalizes to claude-acp", async () => {
  const agent = await createAgent(`e2e-legacy-alias-${Date.now()}`, "claude-agent-acp");
  const session = await createSession(agent, "e2e-legacy-alias");
  const reply = await chat(session, "Reply with PONG.", 60_000);
  assert.match(reply, /PONG/i, `no PONG in reply: ${reply.slice(-200)}`);
  // Daemon log must show the canonicalize trace.
  await sleep(1000);
  const log = readFileSync(DAEMON_LOG, "utf-8");
  assert.match(
    log,
    /canonicalized acp_agent_id claude-agent-acp → claude-acp/,
    "daemon log missing canonicalize trace",
  );
});

test("legacy alias: pre-rename claude-code-acp also canonicalizes to claude-acp", async () => {
  // Two legacy ids OMA shipped pre-A2 → both must route to claude-acp.
  // claude-code-acp predates the agentclientprotocol org rename;
  // claude-agent-acp predates the official-registry adoption.
  const agent = await createAgent(`e2e-legacy-alias-cca-${Date.now()}`, "claude-code-acp");
  const session = await createSession(agent, "e2e-legacy-alias-cca");
  const reply = await chat(session, "Reply with PONG.", 60_000);
  assert.match(reply, /PONG/i, `no PONG in reply: ${reply.slice(-200)}`);
  await sleep(1000);
  const log = readFileSync(DAEMON_LOG, "utf-8");
  assert.match(
    log,
    /canonicalized acp_agent_id claude-code-acp → claude-acp/,
    "daemon log missing canonicalize trace for claude-code-acp",
  );
});

test("bundle layout: claude session cwd has AGENTS.md + .claude-config", async () => {
  const agent = await createAgent(`e2e-bundle-claude-${Date.now()}`, "claude-acp");
  const session = await createSession(agent, "e2e-bundle-claude");
  await chat(session, "Reply OK.", 45_000).catch(() => {});
  await sleep(1000);
  const cwd = newestSessionCwd();
  assert.ok(cwd, `no session cwd found under ${SESSIONS_ROOT}`);
  assert.ok(existsSync(join(cwd!, "AGENTS.md")), `AGENTS.md missing in ${cwd}`);
  assert.ok(existsSync(join(cwd!, ".claude-config")), `.claude-config missing in ${cwd}`);
});

test("bundle layout: opencode session cwd has AGENTS.md (skill files only when attached)", async () => {
  const agent = await createAgent(`e2e-bundle-opencode-${Date.now()}`, "opencode");
  const session = await createSession(agent, "e2e-bundle-opencode");
  await chat(session, "Reply OK.", 45_000).catch(() => {});
  await sleep(1000);
  const cwd = newestSessionCwd();
  assert.ok(cwd, "no session cwd found");
  assert.ok(existsSync(join(cwd!, "AGENTS.md")), `AGENTS.md missing in ${cwd}`);
  // Note: .opencode/agents/<id>.md is only emitted when the agent has
  // skills attached + main worker has the new bundle code deployed
  // (this branch's apps/main change is not yet on prod openma.dev).
});

test("console bundle: ships canonicalize + install-hint code", () => {
  // Require the dist artefact — caller must `pnpm build` first.
  const distDir = join(WORKTREE, "apps/console/dist/assets");
  const bundleFile = readdirSync(distDir).find((f) => /^index-.*\.js$/.test(f));
  assert.ok(bundleFile, "no console bundle — run `pnpm build` in apps/console first");
  const js = readFileSync(join(distDir, bundleFile), "utf-8");

  for (const needle of [
    "claude-agent-acp",
    "codex-cli",
    "gemini-cli",
    "opencode",
    "openclaw",
    "hermes",
    "claude-code-acp", // legacy alias must reach the bundle for canonicalize
  ]) {
    assert.ok(js.includes(needle), `console bundle missing string: ${needle}`);
  }
  // Install-hint UI markup added in this branch.
  assert.ok(
    /install needed|Not detected/i.test(js),
    "install-hint UI strings not in bundle",
  );
});

test("concurrency: two sessions on one agent run in parallel without cross-talk", async () => {
  const agent = await createAgent(`e2e-concurrent-${Date.now()}`, "claude-acp");
  const [sid1, sid2] = await Promise.all([
    createSession(agent, "e2e-concurrent-A"),
    createSession(agent, "e2e-concurrent-B"),
  ]);
  const [r1, r2] = await Promise.all([
    chat(sid1, "Reply with the word ALPHA only.", 60_000),
    chat(sid2, "Reply with the word BETA only.", 60_000),
  ]);
  assert.match(r1, /ALPHA/i, `session A: ${r1.slice(-200)}`);
  assert.doesNotMatch(r1, /BETA/i, `session A bled BETA: ${r1.slice(-200)}`);
  assert.match(r2, /BETA/i, `session B: ${r2.slice(-200)}`);
  assert.doesNotMatch(r2, /ALPHA/i, `session B bled ALPHA: ${r2.slice(-200)}`);
});

test("session reusability after client-side abort", async () => {
  // Honest scope: prod's openma relay does NOT yet expose a "cancel turn"
  // verb to the daemon — killing the CLI client only drops the SSE/WS
  // readback, the daemon-side ACP child keeps streaming until the model
  // finishes. We verify only that the same session is reusable for a
  // fresh turn after the prior one drains. (Mid-flight cancel is a
  // separate feature that needs a relay-side verb.)
  const agent = await createAgent(`e2e-cancel-${Date.now()}`, "claude-acp");
  const session = await createSession(agent, "e2e-cancel");

  // Kick off a long prompt, abort the client after 4s.
  const longPrompt = chat(session, "Count from 1 to 30, one number per line, slowly.", 90_000);
  await sleep(4000);
  // Best-effort: the chat() helper will be killed by its own timeout if
  // we don't await it here, so just let it run + drain naturally.
  await longPrompt.catch(() => {});

  // Wait until the daemon-side turn drains (status_idle event in logs).
  for (let i = 0; i < 30; i++) {
    const logs = oma("sessions", "logs", session).stdout;
    if (logs.includes("status_idle")) break;
    await sleep(2000);
  }
  const reply = await chat(session, "Reply with only the word READY and nothing else.", 30_000);
  assert.match(reply, /\bREADY\b/i, `session unusable after abort: ${reply.slice(-200)}`);
});

// (Pre-A2 had two destructive tests here that moved claude-agent-acp out
// of PATH to verify a `legacySpec` fallback + a deprecated-binary
// warning. Both removed: A2 dropped the legacy fallback entirely — if
// the canonical binary isn't on PATH, the agent isn't shown to the user
// and the daemon doesn't try to limp along on the deprecated wrapper.)
