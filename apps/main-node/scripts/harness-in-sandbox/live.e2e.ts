import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

import { createScriptedMcpServer } from "../../../../test/fakes/scripted-mcp-server";
import {
  buildMcodeDeepSeekConfig,
  buildTrustEnvironment,
  getLiveHarnessProfile,
  type LiveHarnessCredentialMount,
} from "./live-profiles";

const execFileAsync = promisify(execFile);
const harnessId = process.argv[2];
if (!harnessId) throw new Error("Usage: live.e2e.ts <codex-acp|mcode>");

const sessionId = `session_${harnessId.replaceAll("-", "_")}_${Date.now().toString(36)}`;
const nativeRoot = `/workspace/.openma/harness-state/acp/${encodeURIComponent(sessionId)}/${harnessId}/v1/native`;
const profile = getLiveHarnessProfile(harnessId, nativeRoot);
const fixtureRoot = fileURLToPath(
  new URL(`../../test/fixtures/${profile.fixture}/`, import.meta.url),
);
const selectedImage = process.env.OMA_HARNESS_DOCKER_IMAGE ?? profile.image;
const workspaceRoot = await mkdtemp(join(tmpdir(), `oma-${harnessId}-workspace-`));
const repositorySeed = await mkdtemp(join(tmpdir(), `oma-${harnessId}-repo-seed-`));
const trustRoot = await mkdtemp(join(tmpdir(), `oma-${harnessId}-trust-`));
const containerName = `oma-${harnessId}-${Date.now().toString(36)}`;
const sandbox = createDockerDuplexSandbox(containerName);
const diagnostics: string[] = [];
let firstSession: AcpSession | undefined;
let restoredSession: AcpSession | undefined;
let mcpServer: Awaited<ReturnType<typeof startMcpProxy>> | undefined;

const fileToken = `FILE_${Date.now().toString(36)}`;
const repoToken = `REPO_${Date.now().toString(36)}`;
const skillToken = `SKILL_${Date.now().toString(36)}`;
const mcpToken = `MCP_${Date.now().toString(36)}`;
const memoryToken = `MEMORY_${Date.now().toString(36)}`;
const workToken = `WORK_${Date.now().toString(36)}`;

try {
  const sourceCredentialMounts = profile.credentialMounts(homedir());
  for (const mount of sourceCredentialMounts) await access(mount.source);
  const credentialMounts = await prepareCredentialMounts(sourceCredentialMounts);
  const trustBundle = await prepareTrustBundle();
  await prepareWorkspace({ fileToken, repoToken, skillToken });
  mcpServer = await startMcpProxy({ sessionId, workToken, mcpToken });

  if (!process.env.OMA_HARNESS_DOCKER_IMAGE) {
    await docker(["build", "--quiet", "--tag", selectedImage, fixtureRoot]);
  }
  await startContainer(containerName, selectedImage, workspaceRoot, credentialMounts, trustBundle);

  const firstRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  firstSession = await firstRuntime.start({
    agent: {
      command: profile.command,
      args: profile.args,
      cwd: "/workspace",
      env: { ...profile.env, ...buildTrustEnvironment("/run/openma-trust/ca.pem") },
      onDiagnosticLine: recordDiagnostic,
    },
    mcpServers: [{
      name: "openma-certification",
      type: "http",
      url: `http://host.docker.internal:${mcpServer.port}/v1/oma/mcp-proxy/${sessionId}/openma-certification`,
      headers: [{ name: "authorization", value: `Bearer ${workToken}` }],
    }],
    clientCallbacks: { requestPermission: allowOnce },
    restart: { mode: "never" },
    perTurnTimeoutMs: 5 * 60_000,
  });
  await applySessionConfig(firstSession);

  const firstEvents = await collect(firstSession.prompt([
    "Use the openma-certification Skill.",
    "It tells you to read the managed file and cloned repository file, and to call the openma-certification MCP tool.",
    `Also remember ${memoryToken} for the next turn.`,
    "Your final answer must contain all four values from those resources and exactly CERTIFICATION_OK.",
  ].join(" ")));
  requireText(firstEvents, fileToken, "managed file injection");
  requireText(firstEvents, repoToken, "repository injection");
  requireText(firstEvents, skillToken, "Skill discovery");
  requireText(firstEvents, mcpToken, "HTTP MCP proxy");
  requireText(firstEvents, "CERTIFICATION_OK", "first live turn");
  if ((mcpServer.fake.state.counts["tools/call"] ?? 0) < 1) {
    throw new Error(`${harnessId} did not call the HTTP MCP proxy tool`);
  }
  if (mcpServer.unauthorizedRequests !== 0) {
    throw new Error(`${harnessId} made an MCP request without the scoped Work token`);
  }

  const acpSessionId = firstSession.acpSessionId;
  await firstSession.dispose();
  firstSession = undefined;
  const nativeArtifacts = await inspectNativeArtifacts();

  await removeContainer(containerName);
  await startContainer(containerName, selectedImage, workspaceRoot, credentialMounts, trustBundle);

  const restoredRuntime = createAcpRuntime({ type: "sandbox", sandbox });
  restoredSession = await restoredRuntime.start({
    agent: {
      command: profile.command,
      args: profile.args,
      cwd: "/workspace",
      env: { ...profile.env, ...buildTrustEnvironment("/run/openma-trust/ca.pem") },
      onDiagnosticLine: recordDiagnostic,
    },
    resumeAcpSessionId: acpSessionId,
    mcpServers: [{
      name: "openma-certification",
      type: "http",
      url: `http://host.docker.internal:${mcpServer.port}/v1/oma/mcp-proxy/${sessionId}/openma-certification`,
      headers: [{ name: "authorization", value: `Bearer ${workToken}` }],
    }],
    clientCallbacks: { requestPermission: allowOnce },
    restart: { mode: "never" },
    perTurnTimeoutMs: 5 * 60_000,
  });
  await applySessionConfig(restoredSession);
  const restoredEvents = await collect(
    restoredSession.prompt("What exact MEMORY_ token did I ask you to remember? Reply with that token only."),
  );
  requireText(restoredEvents, memoryToken, "native session restore");

  await assertCredentialsNotPersisted();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "harness-in-sandbox",
    harness: profile.id,
    agent: restoredSession.agentInfo,
    protocol_version: restoredSession.protocolVersion,
    sandbox_recreated: true,
    native_restore: true,
    native_artifacts: nativeArtifacts,
    file_injection: true,
    repo_injection: true,
    skill_discovery: true,
    http_mcp_proxy: true,
    mcp_tool_calls: mcpServer.fake.state.counts["tools/call"] ?? 0,
    credential_persistence: false,
    first_event_count: firstEvents.length,
    restored_event_count: restoredEvents.length,
  }, null, 2)}\n`);
} catch (error) {
  if (diagnostics.length > 0) {
    process.stderr.write(`ACP diagnostic tail (${harnessId}):\n${diagnostics.slice(-40).join("\n")}\n`);
  }
  throw error;
} finally {
  await firstSession?.dispose().catch(() => undefined);
  await restoredSession?.dispose().catch(() => undefined);
  await removeContainer(containerName);
  await assertContainerAbsent(containerName);
  await mcpServer?.close();
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(repositorySeed, { recursive: true, force: true });
  await rm(trustRoot, { recursive: true, force: true });
}

async function prepareWorkspace(tokens: {
  fileToken: string;
  repoToken: string;
  skillToken: string;
}): Promise<void> {
  await mkdir(join(workspaceRoot, "inputs"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "inputs", "managed-file.txt"),
    `${tokens.fileToken}\n`,
    "utf8",
  );

  await dockerlessGit(["init", "--quiet"], repositorySeed);
  await writeFile(join(repositorySeed, "repo-token.txt"), `${tokens.repoToken}\n`, "utf8");
  await dockerlessGit(["add", "repo-token.txt"], repositorySeed);
  await dockerlessGit([
    "-c",
    "user.name=OpenMA Certification",
    "-c",
    "user.email=certification@openma.invalid",
    "commit",
    "--quiet",
    "--message",
    "certification fixture",
  ], repositorySeed);
  await dockerlessGit(["clone", "--quiet", repositorySeed, join(workspaceRoot, "repository")]);

  const nativeHostRoot = toHostWorkspacePath(nativeRoot);
  await mkdir(nativeHostRoot, { recursive: true });
  for (const link of profile.credentialLinks) {
    const hostPath = toHostWorkspacePath(link.path);
    await mkdir(dirname(hostPath), { recursive: true });
    await symlink(link.target, hostPath);
  }
  const skillDirectory = toHostWorkspacePath(profile.skillDirectory);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), [
    "---",
    "name: openma-certification",
    "description: Certify managed runtime resource wiring.",
    "---",
    "",
    "When invoked, do all of the following:",
    "1. Read /workspace/inputs/managed-file.txt.",
    "2. Read /workspace/repository/repo-token.txt and confirm /workspace/repository is a Git checkout.",
    "3. Call the `openma_certification_probe` tool from the `openma-certification` MCP server.",
    `4. Include the exact token ${tokens.skillToken} in the final answer.`,
  ].join("\n"), "utf8");
}

async function applySessionConfig(session: AcpSession): Promise<void> {
  for (const option of profile.sessionConfigOptions) {
    const advertised = session.configOptions.find((candidate) => candidate.id === option.id);
    if (!advertised) {
      const ids = session.configOptions.map((candidate) => candidate.id).join(", ") || "<none>";
      throw new Error(`${harnessId} did not advertise config option ${option.id}; advertised: ${ids}`);
    }
    await session.setConfigOption(option.id, option.value);
  }
}

async function inspectNativeArtifacts(): Promise<string[]> {
  const found: string[] = [];
  for (const artifactPath of profile.nativeArtifactPaths) {
    const fullPath = join(toHostWorkspacePath(nativeRoot), artifactPath);
    const info = await stat(fullPath).catch(() => null);
    if (!info) throw new Error(`${harnessId} did not persist native artifact ${artifactPath}`);
    if (info.isDirectory() && await countFiles(fullPath) < 1) {
      throw new Error(`${harnessId} native artifact directory is empty: ${artifactPath}`);
    }
    found.push(artifactPath);
  }
  return found;
}

async function assertCredentialsNotPersisted(): Promise<void> {
  for (const link of profile.credentialLinks) {
    const path = toHostWorkspacePath(link.path);
    const info = await lstat(path).catch(() => null);
    if (!info?.isSymbolicLink()) {
      throw new Error(`${harnessId} credential was copied into the durable workspace: ${relative(workspaceRoot, path)}`);
    }
  }
}

function toHostWorkspacePath(sandboxPath: string): string {
  if (sandboxPath === "/workspace") return workspaceRoot;
  if (!sandboxPath.startsWith("/workspace/")) {
    throw new Error(`Certification path is outside /workspace: ${sandboxPath}`);
  }
  return join(workspaceRoot, sandboxPath.slice("/workspace/".length));
}

async function allowOnce(params: {
  options: Array<{ optionId: string; kind: string }>;
}) {
  const selected = params.options.find((option) => option.kind === "allow_once")
    ?? params.options.find((option) => option.kind === "allow_always");
  return selected
    ? { outcome: { outcome: "selected" as const, optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" as const } };
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
  image: string,
  workspace: string,
  credentialMounts: LiveHarnessCredentialMount[],
  trustBundle: string,
): Promise<void> {
  const args = [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--mount",
    `type=bind,source=${workspace},destination=/workspace`,
    "--mount",
    `type=bind,source=${trustBundle},destination=/run/openma-trust/ca.pem,readonly`,
  ];
  for (const mount of credentialMounts) {
    args.push(
      "--mount",
      `type=bind,source=${mount.source},destination=${mount.destination},readonly`,
    );
  }
  args.push(
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "while :; do sleep 3600; done",
  );
  await docker(args);
}

async function prepareTrustBundle(): Promise<string> {
  const pieces: string[] = [];
  for (const candidate of ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"]) {
    const source = await readFile(candidate, "utf8").catch(() => "");
    if (source.includes("BEGIN CERTIFICATE")) pieces.push(source);
  }
  if (process.platform === "darwin") {
    const keychains = [
      "/Library/Keychains/System.keychain",
      join(homedir(), "Library", "Keychains", "login.keychain-db"),
    ];
    for (const keychain of keychains) {
      if (!await stat(keychain).catch(() => null)) continue;
      const { stdout } = await execFileAsync(
        "security",
        ["find-certificate", "-a", "-p", keychain],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      if (stdout.includes("BEGIN CERTIFICATE")) pieces.push(stdout);
    }
  }
  if (pieces.length === 0) throw new Error("No host CA certificates available for live Docker lane");
  const bundle = join(trustRoot, "ca.pem");
  await writeFile(bundle, pieces.join("\n"), { encoding: "utf8", mode: 0o444 });
  return bundle;
}

async function prepareCredentialMounts(
  mounts: LiveHarnessCredentialMount[],
): Promise<LiveHarnessCredentialMount[]> {
  if (!profile.defaultModelOverride) return mounts;
  if (profile.id !== "mcode") {
    throw new Error(`${harnessId} declares an unsupported live model override`);
  }
  const credential = process.env.DEEPSEEK_API_KEY?.trim();
  if (!credential) throw new Error("DEEPSEEK_API_KEY is required for MCode live certification");
  const ephemeralConfig = join(trustRoot, "mcode-config.yaml");
  await writeFile(ephemeralConfig, buildMcodeDeepSeekConfig(credential), {
    encoding: "utf8",
    mode: 0o400,
  });
  return [
    ...mounts,
    {
      source: ephemeralConfig,
      destination: "/run/openma-credentials/mcode-config.yaml",
    },
  ];
}

async function startMcpProxy(input: {
  sessionId: string;
  workToken: string;
  mcpToken: string;
}) {
  const fake = createScriptedMcpServer({
    sessionId: `mcp-${input.sessionId}`,
    tools: [{
      name: "openma_certification_probe",
      description: "Return the unique OpenMA HTTP MCP proxy certification token.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
    callTool({ name }) {
      if (name !== "openma_certification_probe") throw new Error(`Unexpected MCP tool ${name}`);
      return { content: [{ type: "text", text: input.mcpToken }] };
    },
  });
  let unauthorizedRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${input.workToken}`) {
        unauthorizedRequests += 1;
        response.writeHead(401).end("invalid Work token");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const target = new Request(`http://openma-certification.local${request.url ?? "/"}`, {
        method: request.method,
        headers,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      });
      const result = await fake.fetch(target);
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP proxy did not bind a TCP port");
  return {
    fake,
    port: address.port,
    get unauthorizedRequests() { return unauthorizedRequests; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function recordDiagnostic(line: string): void {
  const secrets = [workToken, process.env.DEEPSEEK_API_KEY ?? ""];
  diagnostics.push(secrets
    .filter((secret) => secret.length > 0)
    .reduce((output, secret) => output.replaceAll(secret, "<redacted>"), line));
  if (diagnostics.length > 200) diagnostics.splice(0, diagnostics.length - 200);
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
  throw new Error(`Live harness certification leaked Docker container ${name}`);
}

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, {
      env: process.env,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
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

async function dockerlessGit(args: string[], cwd: string = workspaceRoot): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 30_000 });
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
