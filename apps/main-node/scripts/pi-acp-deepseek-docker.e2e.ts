import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import type { AcpSession } from "@open-managed-agents/acp-runtime";
import type {
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
} from "@open-managed-agents/sandbox";

const execFileAsync = promisify(execFile);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required (its value is never logged)");

const fixtureRoot = fileURLToPath(new URL("../test/fixtures/pi-acp-sandbox/", import.meta.url));
const image = process.env.OMA_PI_ACP_DOCKER_IMAGE
  ?? "openma/pi-acp-certification:pi-0.84.4-acp-0.0.33";
const workspaceRoot = await mkdtemp(join(tmpdir(), "oma-pi-acp-docker-"));
const containerName = `oma-pi-acp-${Date.now().toString(36)}`;
const sessionId = `session_pi_acp_${Date.now().toString(36)}`;
const nativeRoot = `/workspace/.openma/harness-state/acp/${encodeURIComponent(sessionId)}/pi/v1/native`;
const nativeEnvironment = {
  HOME: `${nativeRoot}/home`,
  PI_CODING_AGENT_DIR: `${nativeRoot}/home/.pi/agent`,
};
const sandbox = createDockerDuplexSandbox(containerName);
let firstSession: AcpSession | undefined;
let restoredSession: AcpSession | undefined;

try {
  if (!process.env.OMA_PI_ACP_DOCKER_IMAGE) {
    await docker(["build", "--quiet", "--tag", image, fixtureRoot]);
  }
  await startContainer(containerName, image, workspaceRoot, apiKey);

  const firstRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  firstSession = await firstRuntime.start({
    agent: {
      command: "pi-acp",
      cwd: "/workspace",
      env: nativeEnvironment,
    },
    restart: { mode: "never" },
    perTurnTimeoutMs: 60_000,
  });
  await firstSession.setConfigOption("model", "deepseek/deepseek-v4-flash");
  await firstSession.setConfigOption("thought_level", "off");

  const nonce = `PI_NATIVE_${Date.now().toString(36)}`;
  const firstEvents = await collect(
    firstSession.prompt(`Remember the exact token ${nonce}. Reply with exactly PI_STATE_SAVED.`),
  );
  requireText(firstEvents, "PI_STATE_SAVED", "first Pi ACP turn");
  const acpSessionId = firstSession.acpSessionId;
  await firstSession.dispose();
  firstSession = undefined;

  const sessionMapPath = join(
    workspaceRoot,
    ".openma/harness-state/acp",
    encodeURIComponent(sessionId),
    "pi/v1/native/home/.pi/pi-acp/session-map.json",
  );
  const sessionMap = JSON.parse(await readFile(sessionMapPath, "utf8")) as {
    sessions?: Record<string, unknown>;
  };
  if (!(acpSessionId in (sessionMap.sessions ?? {}))) {
    throw new Error("pi-acp native session map did not retain the ACP session id");
  }
  const nativeSessionDir = join(
    workspaceRoot,
    ".openma/harness-state/acp",
    encodeURIComponent(sessionId),
    "pi/v1/native/home/.pi/agent/sessions",
  );
  const nativeSessionFiles = await countFiles(nativeSessionDir);
  if (nativeSessionFiles < 1) throw new Error("Pi did not persist a native session file");

  // Kill the whole sandbox, then recreate it over the same durable workspace.
  // This proves recovery does not depend on the old process or container memory.
  await removeContainer(containerName);
  await startContainer(containerName, image, workspaceRoot, apiKey);

  const restoredRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  restoredSession = await restoredRuntime.start({
    agent: {
      command: "pi-acp",
      cwd: "/workspace",
      env: nativeEnvironment,
    },
    resumeAcpSessionId: acpSessionId,
    restart: { mode: "never" },
    perTurnTimeoutMs: 60_000,
  });
  await restoredSession.setConfigOption("model", "deepseek/deepseek-v4-flash");
  await restoredSession.setConfigOption("thought_level", "off");
  const restoredEvents = await collect(
    restoredSession.prompt("What exact token did I ask you to remember? Reply with that token only."),
  );
  requireText(restoredEvents, nonce, "restored Pi ACP turn");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "harness-in-sandbox",
    agent: restoredSession.agentInfo,
    protocol_version: restoredSession.protocolVersion,
    model: "deepseek-v4-flash",
    thinking: false,
    sandbox_recreated: true,
    native_restore: true,
    native_session_files: nativeSessionFiles,
    first_event_count: firstEvents.length,
    restored_event_count: restoredEvents.length,
  }, null, 2)}\n`);
} finally {
  await firstSession?.dispose().catch(() => undefined);
  await restoredSession?.dispose().catch(() => undefined);
  await removeContainer(containerName);
  await assertContainerAbsent(containerName);
  await rm(workspaceRoot, { recursive: true, force: true });
}

function createDockerDuplexSandbox(container: string): SandboxDuplexProcessPort {
  return {
    async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
      const args = ["exec", "--interactive"];
      if (spec.cwd) args.push("--workdir", spec.cwd);
      for (const [name, value] of Object.entries(spec.env ?? {})) {
        if (value !== undefined) args.push("--env", `${name}=${value}`);
      }
      args.push(container, spec.command, ...(spec.args ?? []));
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      return {
        stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
        exited,
        async kill(signal = "SIGTERM") {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        },
      };
    },
  };
}

async function startContainer(
  name: string,
  selectedImage: string,
  workspace: string,
  credential: string,
): Promise<void> {
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--env",
    "DEEPSEEK_API_KEY",
    "--mount",
    `type=bind,source=${workspace},destination=/workspace`,
    "--entrypoint",
    "/bin/sh",
    selectedImage,
    "-c",
    "while :; do sleep 3600; done",
  ], { DEEPSEEK_API_KEY: credential });
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name]).catch(() => undefined);
}

async function assertContainerAbsent(name: string): Promise<void> {
  try {
    await docker(["container", "inspect", name]);
  } catch {
    return;
  }
  throw new Error(`Pi ACP certification leaked Docker container ${name}`);
}

async function docker(
  args: string[],
  extraEnvironment: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      env: { ...process.env, ...extraEnvironment },
      timeout: 5 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    throw new Error(`docker ${args[0] ?? "command"} failed: ${stderr || message}`);
  }
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function requireText(events: unknown[], expected: string, label: string): void {
  const text = events
    .map((event) => (event as { content?: { text?: unknown } }).content?.text)
    .filter((value): value is string => typeof value === "string")
    .join("");
  if (!text.includes(expected)) throw new Error(`${label} did not contain ${expected}: ${text}`);
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(join(root, entry.name)) : 1;
  }
  return count;
}
