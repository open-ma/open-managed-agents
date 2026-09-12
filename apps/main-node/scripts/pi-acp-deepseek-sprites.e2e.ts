import { createHash, randomUUID } from "node:crypto";

import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import type { AcpSession } from "@open-managed-agents/acp-runtime";
import {
  createSpritesSandbox,
  type SpritesRuntime,
} from "@open-managed-agents/managed-runtime-sprites";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const spritesToken = process.env.SPRITES_TOKEN?.trim();
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required (its value is never logged)");
if (!spritesToken) throw new Error("SPRITES_TOKEN is required (its value is never logged)");

const sessionId = `session_pi_sprites_${randomUUID()}`;
const nativeRoot = `/workspace/.openma/harness-state/acp/${encodeURIComponent(sessionId)}/pi/v1/native`;
const nativeEnvironment = {
  DEEPSEEK_API_KEY: apiKey,
  HOME: `${nativeRoot}/home`,
  PATH: "/.sprite/bin:/home/sprite/.local/bin:/usr/local/bin:/usr/bin:/bin",
  PI_CODING_AGENT_DIR: `${nativeRoot}/home/.pi/agent`,
};
const sandboxEnvironment = {
  SPRITES_TOKEN: spritesToken,
  OPENMA_WORKSPACE_ID: "sprites-live-certification",
  OPENMA_ENVIRONMENT_ID: "sprites-live-certification",
};
const sandboxContext = { sessionId, workdir: "/workspace" };
const expectedRuntimeId = `oma-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
let sandbox: SpritesRuntime | undefined;
let firstSession: AcpSession | undefined;
let restoredSession: AcpSession | undefined;
const diagnostics: string[] = [];
let piAcpCommand = "";

try {
  sandbox = await stage("create Sprite", createSpritesSandbox(sandboxContext, sandboxEnvironment), 60_000);
  if (sandbox.runtimeHandle().runtimeId !== expectedRuntimeId) {
    throw new Error("Sprite runtime identity is not deterministic for the Session");
  }
  await stage("renew Sprite keepalive", sandbox.renewLease({ ttlMs: 5 * 60_000 }));
  await stage("install Pi ACP", execOk(
    sandbox,
    "npm install --global @earendil-works/pi-coding-agent@0.84.4 pi-acp@0.0.33 >/tmp/openma-npm-install.log 2>&1",
    5 * 60_000,
  ), 6 * 60_000);
  const npmPrefix = (await stage(
    "read npm prefix",
    sandbox.exec("npm prefix --global"),
  )).trim();
  piAcpCommand = `${npmPrefix}/bin/pi-acp`;
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(piAcpCommand)) {
    throw new Error("Pi ACP installation did not expose a safe executable path");
  }
  await stage("locate Pi ACP", sandbox.exec(`test -x ${shellQuote(piAcpCommand)}`));
  await stage("prepare native state", execOk(
    sandbox,
    `mkdir -p ${shellQuote(nativeEnvironment.HOME)} ${shellQuote(nativeEnvironment.PI_CODING_AGENT_DIR)}`,
  ));
  await stage("prepare output path", sandbox.mountSessionOutputs({
    tenantId: "sprites-live-certification",
    sessionId,
  }));

  const firstRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  firstSession = await stage("start Pi ACP", firstRuntime.start({
    agent: {
      command: piAcpCommand,
      cwd: "/workspace",
      env: nativeEnvironment,
      onDiagnosticLine: recordDiagnostic,
    },
    restart: { mode: "never" },
    perTurnTimeoutMs: 90_000,
  }));
  await firstSession.setConfigOption("model", "deepseek/deepseek-v4-flash");
  await firstSession.setConfigOption("thought_level", "off");

  const nonce = `PI_SPRITES_NATIVE_${Date.now().toString(36)}`;
  const firstEvents = await stage("first DeepSeek turn", collect(
    firstSession.prompt(`Remember the exact token ${nonce}. Reply with exactly PI_SPRITES_STATE_SAVED.`),
  ), 120_000);
  requireText(firstEvents, "PI_SPRITES_STATE_SAVED", "first Pi ACP Sprite turn");
  const acpSessionId = firstSession.acpSessionId;
  await firstSession.dispose();
  firstSession = undefined;

  const nativeFiles = Number(await stage("inspect native state", sandbox.exec(
    `find ${shellQuote(nativeEnvironment.PI_CODING_AGENT_DIR)} -type f | wc -l`,
  )));
  if (!Number.isSafeInteger(nativeFiles) || nativeFiles < 1) {
    throw new Error("Pi did not persist native Session files inside the Sprite workspace");
  }

  const checkpoint = await stage("release Sprite activity", sandbox.suspend({ kind: "filesystem" }));
  sandbox = await stage("reattach Sprite", createSpritesSandbox(sandboxContext, sandboxEnvironment), 60_000);
  await stage("resume retained filesystem", sandbox.resume(checkpoint));
  await stage("renew keepalive after resume", sandbox.renewLease({ ttlMs: 5 * 60_000 }));

  const restoredRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  restoredSession = await stage("resume Pi ACP Session", restoredRuntime.start({
    agent: {
      command: piAcpCommand,
      cwd: "/workspace",
      env: nativeEnvironment,
      onDiagnosticLine: recordDiagnostic,
    },
    resumeAcpSessionId: acpSessionId,
    restart: { mode: "never" },
    perTurnTimeoutMs: 90_000,
  }));
  await restoredSession.setConfigOption("model", "deepseek/deepseek-v4-flash");
  await restoredSession.setConfigOption("thought_level", "off");
  const restoredEvents = await stage("restored DeepSeek turn", collect(
    restoredSession.prompt("What exact token did I ask you to remember? Reply with that token only."),
  ), 120_000);
  requireText(restoredEvents, nonce, "restored Pi ACP Sprite turn");
  await sandbox.writeFile("/mnt/session/outputs/pi-sprites-certification.txt", `${nonce}\n`);
  const output = await sandbox.readFile("/mnt/session/outputs/pi-sprites-certification.txt");
  if (output.trim() !== nonce) throw new Error("Sprite Session output did not round-trip");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "harness-in-sandbox",
    provider: "sprites",
    harness: "pi-acp",
    model: "deepseek-v4-flash",
    thinking: false,
    process_restarted: true,
    provider_reattached: true,
    native_restore: true,
    native_session_files: nativeFiles,
    retained_output: true,
    first_event_count: firstEvents.length,
    restored_event_count: restoredEvents.length,
  }, null, 2)}\n`);
} catch (error) {
  if (diagnostics.length > 0) {
    process.stderr.write(`Pi ACP diagnostic tail (Sprites):\n${diagnostics.slice(-30).join("\n")}\n`);
  }
  throw error;
} finally {
  await firstSession?.dispose().catch(() => undefined);
  await restoredSession?.dispose().catch(() => undefined);
  await sandbox?.destroy().catch(() => undefined);
}

async function execOk(
  runtime: SpritesRuntime,
  command: string,
  timeoutMs = 120_000,
): Promise<void> {
  const output = await runtime.exec(command, timeoutMs);
  const failure = output.match(/\[exit (\d+)\]$/u);
  if (failure) {
    throw new Error(`Sprite command exited with ${failure[1]}`);
  }
}

async function stage<T>(label: string, task: Promise<T>, timeoutMs = 30_000): Promise<T> {
  process.stdout.write(`[sprites-pi-live] ${label}: start\n`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    process.stdout.write(`[sprites-pi-live] ${label}: pass\n`);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function requireText(events: unknown[], expected: string, label: string): void {
  const text = events
    .map((event) => (event as { content?: { text?: unknown } }).content?.text)
    .filter((value): value is string => typeof value === "string")
    .join("");
  if (!text.includes(expected)) throw new Error(`${label} did not contain its expected marker`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function recordDiagnostic(line: string): void {
  diagnostics.push(line.replaceAll(apiKey, "<redacted>"));
}
