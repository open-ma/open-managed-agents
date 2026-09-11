import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  captureAcpSandboxAgentState,
  hasRequiredAcpSandboxAgentState,
  managedMcpProxyFromWorkEnvironment,
  materializeAcpSandboxAgentState,
  projectAcpSandboxMcpServers,
  prepareAcpSandboxAgent,
  releaseAcpSandboxAgentState,
  restoreAcpSandboxAgentState,
  resolveAcpSandboxAgentAdapter,
} from "./sandbox-agent.js";

const execFileAsync = promisify(execFile);

describe("Harbor-style ACP sandbox agent preparation", () => {
  it("derives the MCP gateway capability from the official Work secret", () => {
    const secret = Buffer.from(JSON.stringify({
      sessions_token: "sk-ant-req-current-claim",
    })).toString("base64url");

    expect(managedMcpProxyFromWorkEnvironment({
      ANTHROPIC_BASE_URL: "https://api.openma.test/v1/",
      ANTHROPIC_WORK_SECRET: secret,
    })).toEqual({
      gatewayBaseUrl: "https://api.openma.test/v1/",
      sessionsToken: "sk-ant-req-current-claim",
    });
    expect(managedMcpProxyFromWorkEnvironment({
      ANTHROPIC_BASE_URL: "https://api.openma.test",
      ANTHROPIC_WORK_SECRET: "not-valid-base64",
    })).toBeNull();
  });

  it("projects managed MCP servers through the session-scoped HTTP gateway", () => {
    expect(projectAcpSandboxMcpServers({
      sessionId: "session/01",
      gatewayBaseUrl: "https://api.openma.test/root/",
      sessionsToken: "sk-ant-req-v1.current-work",
      servers: [
        { name: "linear/main", type: "url", url: "https://linear.example/mcp" },
        { name: "local", type: "stdio" },
      ],
    })).toEqual([
      {
        type: "http",
        name: "linear/main",
        url: "https://api.openma.test/v1/oma/mcp-proxy/session%2F01/linear%2Fmain",
        headers: [{
          name: "Authorization",
          value: "Bearer sk-ant-req-v1.current-work",
        }],
      },
    ]);
  });

  it("rejects a non-HTTP gateway and never falls back to the upstream MCP URL", () => {
    expect(() => projectAcpSandboxMcpServers({
      sessionId: "session_01",
      gatewayBaseUrl: "file:///tmp/proxy",
      sessionsToken: "work-token",
      servers: [{ name: "linear", type: "url", url: "https://linear.example/mcp" }],
    })).toThrow(/http/i);
  });

  it("creates a per-agent launch plan with native resume and lifecycle policy", () => {
    const plan = prepareAcpSandboxAgent({
      sessionId: "session/pi",
      agent: {
        id: "pi-acp",
        command: "pi-acp",
        args: ["--stdio"],
        env: { KEEP: "yes" },
      },
    });

    expect(plan).toMatchObject({
      adapter: {
        id: "pi",
        provenance: "harbor",
        nativeResume: true,
      },
      binding: {
        adapterId: "pi",
        resume: "native-and-acp",
        nativePath:
          "/tmp/openma-harness-state/acp/session%2Fpi/pi/v1/native",
      },
      launch: {
        command: "pi-acp",
        args: ["--stdio"],
        cwd: "/workspace",
        env: {
          KEEP: "yes",
          OPENMA_ACP_STATE_ROOT:
            "/tmp/openma-harness-state/acp/session%2Fpi/pi/v1",
        },
      },
      lifecycle: {
        onShutdown: "retain",
        onCrash: "retain-and-recover",
        onDestroy: "delete",
      },
    });
  });

  it("keeps the agent-native home outside the durable workspace checkpoint", () => {
    const plan = prepareAcpSandboxAgent({
      sessionId: "session/isolated",
      agent: {
        id: "codex-acp",
        command: "codex-acp",
        env: { OPENAI_API_KEY: "ephemeral-secret" },
      },
    });

    expect(plan.binding.nativePath).toBe(
      "/tmp/openma-harness-state/acp/session%2Fisolated/codex/v1/native",
    );
    expect(plan.launch.env.CODEX_HOME).toBe(plan.binding.nativePath);
    expect(plan.binding.nativePath.startsWith("/workspace/")).toBe(false);
    expect(plan.binding.sessionArtifacts).toEqual([
      {
        path:
          "/workspace/.openma/harness-state/acp/session%2Fisolated/codex/v1/native/sessions",
        runtimePath:
          "/tmp/openma-harness-state/acp/session%2Fisolated/codex/v1/native/sessions",
        kind: "directory",
        requiredForResume: true,
      },
    ]);
  });

  it("captures and restores only Harbor-style native session artifacts", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "openma-acp-state-test-"));
    const sessionId = `session-${workdir.split("-").at(-1)}`;
    const plan = prepareAcpSandboxAgent({
      sessionId,
      agent: { id: "codex-acp", command: "codex-acp" },
    });
    const sandboxPath = (path: string) => path.startsWith("/workspace/")
      ? join(workdir, path.slice("/workspace/".length))
      : path;
    const sandbox = {
      async writeFile(path: string, content: string) {
        const target = sandboxPath(path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      },
      async exec(command: string) {
        const result = await execFileAsync("/bin/sh", ["-c", command], {
          cwd: workdir,
        });
        return result.stdout;
      },
    };

    try {
      await mkdir(join(plan.binding.nativePath, "sessions/2026/09/07"), {
        recursive: true,
      });
      await writeFile(
        join(plan.binding.nativePath, "sessions/2026/09/07/rollout.jsonl"),
        "native transcript\n",
      );
      await writeFile(
        join(plan.binding.nativePath, "config.toml"),
        "api_key = 'must-not-persist'\n",
      );

      await captureAcpSandboxAgentState(sandbox, plan);

      await expect(readFile(
        sandboxPath(`${plan.binding.checkpointNativePath}/sessions/2026/09/07/rollout.jsonl`),
        "utf8",
      )).resolves.toBe("native transcript\n");
      await expect(access(
        sandboxPath(`${plan.binding.checkpointNativePath}/config.toml`),
        constants.F_OK,
      )).rejects.toMatchObject({ code: "ENOENT" });

      await rm(plan.binding.nativePath, { recursive: true, force: true });
      await restoreAcpSandboxAgentState(sandbox, plan);
      await expect(readFile(
        join(plan.binding.nativePath, "sessions/2026/09/07/rollout.jsonl"),
        "utf8",
      )).resolves.toBe("native transcript\n");
      await expect(access(
        join(plan.binding.nativePath, "config.toml"),
        constants.F_OK,
      )).rejects.toMatchObject({ code: "ENOENT" });

      await releaseAcpSandboxAgentState(sandbox, plan, "replace");
      await expect(access(plan.binding.nativePath, constants.F_OK))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(
        sandboxPath(`${plan.binding.checkpointNativePath}/sessions/2026/09/07/rollout.jsonl`),
        constants.F_OK,
      )).resolves.toBeUndefined();

      await releaseAcpSandboxAgentState(sandbox, plan, "destroy");
      await expect(access(
        sandboxPath(plan.binding.rootPath),
        constants.F_OK,
      )).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(plan.binding.nativePath, { recursive: true, force: true });
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("keeps an ACP-only adapter explicit instead of claiming native resume", () => {
    const plan = prepareAcpSandboxAgent({
      sessionId: "session/aider",
      agent: { id: "aider-acp", command: "aider-acp" },
    });

    expect(plan.adapter).toEqual({
      id: "aider",
      provenance: "oma",
      nativeResume: false,
    });
    expect(plan.binding).toMatchObject({
      adapterId: "aider",
      durability: "acp",
      resume: "acp-only",
      sessionArtifacts: [],
    });
    expect(plan.lifecycle.onCrash).toBe("retain-and-recover");
  });

  it("resolves legacy command paths and unknown agents fail closed to opaque ACP", () => {
    expect(resolveAcpSandboxAgentAdapter({
      command: "/usr/local/bin/codex-acp",
    })).toEqual({
      id: "codex",
      provenance: "harbor",
      nativeResume: true,
    });
    expect(resolveAcpSandboxAgentAdapter({
      id: "community-acp",
      command: "community-acp",
    })).toEqual({
      id: "opaque",
      provenance: "oma",
      nativeResume: false,
    });
  });

  it("materializes and validates the exclusive native-session artifact manifest", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const commands: string[] = [];
    const plan = prepareAcpSandboxAgent({
      sessionId: "session_codex",
      agent: { id: "codex-acp", command: "codex-acp" },
    });
    const sandbox = {
      async writeFile(path: string, content: string) {
        writes.push({ path, content });
      },
      async exec(command: string) {
        commands.push(command);
        return "present";
      },
    };

    await materializeAcpSandboxAgentState(sandbox, plan);
    await expect(hasRequiredAcpSandboxAgentState(sandbox, plan)).resolves.toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(`${plan.binding.rootPath}/session-binding.json`);
    expect(JSON.parse(writes[0]?.content ?? "null")).toEqual({
      version: 1,
      adapter_id: "codex",
      durability: "native",
      resume: "native-and-acp",
      session_artifacts: plan.binding.sessionArtifacts,
    });
    expect(commands).toEqual([
      expect.stringContaining("native/sessions"),
    ]);
  });

  it("fails native resume closed and applies retain/delete lifecycle policy", async () => {
    const commands: string[] = [];
    const plan = prepareAcpSandboxAgent({
      sessionId: "session_claude",
      agent: { id: "claude-acp", command: "claude-agent-acp" },
    });
    const sandbox = {
      async writeFile() {},
      async exec(command: string) {
        commands.push(command);
        return command.startsWith("if [") ? "missing" : "";
      },
    };

    await expect(hasRequiredAcpSandboxAgentState(sandbox, plan)).resolves.toBe(false);
    await releaseAcpSandboxAgentState(sandbox, plan, "shutdown");
    expect(commands).toHaveLength(2);
    expect(commands.at(-1)).toContain(plan.binding.nativePath);
    await releaseAcpSandboxAgentState(sandbox, plan, "destroy");
    expect(commands.at(-1)).toContain("rm -rf --");
    expect(commands.at(-1)).toContain("session_claude/claude-code/v1");
  });
});
