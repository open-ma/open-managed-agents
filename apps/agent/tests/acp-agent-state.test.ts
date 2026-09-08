import { describe, expect, it } from "vitest";

import {
  ACP_NATIVE_STATE_PROFILES,
  bindAcpAgentState,
} from "../src/harness/acp-agent-state";

describe("ACP agent-native session state", () => {
  it("covers Harbor-derived native state profiles available through ACP or an OMA overlay", () => {
    expect(ACP_NATIVE_STATE_PROFILES.map((profile) => profile.id).sort()).toEqual([
      "aider",
      "claude-code",
      "codex",
      "copilot",
      "cortex-code",
      "dsh",
      "gemini",
      "goose",
      "hermes",
      "junie",
      "kimi",
      "kimi-code",
      "mcode",
      "mimo",
      "mistral-vibe",
      "opencode",
      "pi",
      "qwen-code",
    ]);
    for (const profile of ACP_NATIVE_STATE_PROFILES) {
      if (profile.durability === "native") {
        expect(profile.sessionArtifacts("/native"), profile.id).not.toHaveLength(0);
      } else {
        expect(profile.sessionArtifacts("/native"), profile.id).toHaveLength(0);
      }
      for (const artifact of profile.sessionArtifacts("/native")) {
        expect(artifact.path, profile.id).toMatch(/^\/native(?:\/|$)/);
      }
    }
  });

  it("isolates Claude Code and declares only its native session directory", () => {
    const binding = bindAcpAgentState({
      sessionId: "session/../unsafe",
      agent: {
        id: "claude-acp",
        command: "claude-agent-acp",
        args: ["--stdio"],
        env: { CLAUDE_CONFIG_DIR: "/tmp/escape", KEEP: "yes" },
      },
    });

    expect(binding).toEqual({
      adapterId: "claude-code",
      durability: "native",
      resume: "native-and-acp",
      rootPath:
        "/workspace/.openma/harness-state/acp/session%2F..%2Funsafe/claude-code/v1",
      checkpointPath:
        "/workspace/.openma/harness-state/acp/session%2F..%2Funsafe/claude-code/v1/acp-session.json",
      checkpointNativePath:
        "/workspace/.openma/harness-state/acp/session%2F..%2Funsafe/claude-code/v1/native",
      nativePath:
        "/tmp/openma-harness-state/acp/session%2F..%2Funsafe/claude-code/v1/native",
      sessionArtifacts: [{
        path:
          "/workspace/.openma/harness-state/acp/session%2F..%2Funsafe/claude-code/v1/native/projects",
        runtimePath:
          "/tmp/openma-harness-state/acp/session%2F..%2Funsafe/claude-code/v1/native/projects",
        kind: "directory",
        requiredForResume: true,
      }],
      agent: {
        id: "claude-acp",
        command: "claude-agent-acp",
        args: ["--stdio"],
        env: {
          CLAUDE_CONFIG_DIR:
            "/tmp/openma-harness-state/acp/session%2F..%2Funsafe/claude-code/v1/native",
          KEEP: "yes",
          OPENMA_ACP_STATE_ROOT:
            "/tmp/openma-harness-state/acp/session%2F..%2Funsafe/claude-code/v1",
        },
      },
    });
  });

  it("forces Codex state into its own CODEX_HOME", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_1",
      agent: { id: "codex-acp", command: "codex-acp" },
    });

    expect(binding.adapterId).toBe("codex");
    expect(binding.durability).toBe("native");
    expect(binding.agent.env).toMatchObject({
      CODEX_HOME:
        "/tmp/openma-harness-state/acp/session_1/codex/v1/native",
    });
    expect(binding.checkpointNativePath).toBe(
      "/workspace/.openma/harness-state/acp/session_1/codex/v1/native",
    );
    expect(binding.sessionArtifacts[0]).toMatchObject({
      path: "/workspace/.openma/harness-state/acp/session_1/codex/v1/native/sessions",
      runtimePath: "/tmp/openma-harness-state/acp/session_1/codex/v1/native/sessions",
    });
  });

  it("binds Gemini CLI sessions through its supported isolated home", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_gemini",
      agent: {
        id: "gemini",
        command: "gemini",
        args: ["--acp"],
        env: { GEMINI_CLI_HOME: "/tmp/escape" },
      },
    });

    expect(binding).toMatchObject({
      adapterId: "gemini",
      durability: "native",
      resume: "native-and-acp",
      agent: {
        env: {
          GEMINI_CLI_HOME:
            "/tmp/openma-harness-state/acp/session_gemini/gemini/v1/native",
        },
      },
    });
  });

  it("binds OpenCode's Harbor-proven XDG data and state directories", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_opencode",
      agent: {
        id: "opencode",
        command: "opencode",
        args: ["acp"],
        env: {
          XDG_DATA_HOME: "/tmp/data-escape",
          XDG_STATE_HOME: "/tmp/state-escape",
        },
      },
    });

    expect(binding).toMatchObject({
      adapterId: "opencode",
      durability: "native",
      resume: "native-and-acp",
      agent: {
        env: {
          XDG_DATA_HOME:
            "/tmp/openma-harness-state/acp/session_opencode/opencode/v1/native/xdg-data",
          XDG_STATE_HOME:
            "/tmp/openma-harness-state/acp/session_opencode/opencode/v1/native/xdg-state",
        },
      },
    });
  });

  it("binds both pi and pi-acp state roots needed for native session resume", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_pi",
      agent: {
        id: "pi-acp",
        command: "pi-acp",
        env: {
          HOME: "/tmp/home-escape",
          PI_CODING_AGENT_DIR: "/tmp/pi-escape",
        },
      },
    });

    expect(binding).toMatchObject({
      adapterId: "pi",
      durability: "native",
      resume: "native-and-acp",
      agent: {
        env: {
          HOME:
            "/tmp/openma-harness-state/acp/session_pi/pi/v1/native/home",
          PI_CODING_AGENT_DIR:
            "/tmp/openma-harness-state/acp/session_pi/pi/v1/native/home/.pi/agent",
        },
      },
    });
  });

  it("binds MCode's documented data root for ACP session resume", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_mcode",
      agent: {
        id: "mcode",
        command: "mcode",
        args: ["acp"],
        env: { MINIMAX_DATA_DIR: "/tmp/mcode-escape" },
      },
    });

    expect(binding).toMatchObject({
      adapterId: "mcode",
      durability: "native",
      resume: "native-and-acp",
      agent: {
        env: {
          MINIMAX_DATA_DIR:
            "/tmp/openma-harness-state/acp/session_mcode/mcode/v1/native",
        },
      },
    });
  });

  it.each([
    {
      id: "github-copilot-cli",
      adapterId: "copilot",
      env: {
        HOME:
          "/tmp/openma-harness-state/acp/session_matrix/copilot/v1/native/home",
      },
    },
    {
      id: "cortex-code",
      adapterId: "cortex-code",
      env: {
        HOME:
          "/tmp/openma-harness-state/acp/session_matrix/cortex-code/v1/native/home",
      },
    },
    {
      id: "goose",
      adapterId: "goose",
      env: {
        XDG_DATA_HOME:
          "/tmp/openma-harness-state/acp/session_matrix/goose/v1/native/xdg-data",
        XDG_STATE_HOME:
          "/tmp/openma-harness-state/acp/session_matrix/goose/v1/native/xdg-state",
      },
    },
    {
      id: "junie",
      adapterId: "junie",
      env: {
        HOME:
          "/tmp/openma-harness-state/acp/session_matrix/junie/v1/native/home",
      },
    },
    {
      id: "kimi",
      adapterId: "kimi",
      env: {
        KIMI_SHARE_DIR:
          "/tmp/openma-harness-state/acp/session_matrix/kimi/v1/native/share",
      },
    },
    {
      id: "qwen-code",
      adapterId: "qwen-code",
      env: {
        HOME:
          "/tmp/openma-harness-state/acp/session_matrix/qwen-code/v1/native/home",
      },
    },
    {
      id: "mistral-vibe",
      adapterId: "mistral-vibe",
      env: {
        VIBE_HOME:
          "/tmp/openma-harness-state/acp/session_matrix/mistral-vibe/v1/native",
      },
    },
  ])("binds Harbor's native session contract for $id", ({ id, adapterId, env }) => {
    const binding = bindAcpAgentState({
      sessionId: "session_matrix",
      agent: { id, command: "registry-managed-command" },
    });

    expect(binding).toMatchObject({
      adapterId,
      durability: "native",
      agent: { env },
    });
    expect(binding.nativePath).toBe(
      `/tmp/openma-harness-state/acp/session_matrix/${adapterId}/v1/native`,
    );
    expect(binding.checkpointNativePath).toBe(
      `/workspace/.openma/harness-state/acp/session_matrix/${adapterId}/v1/native`,
    );
    for (const artifact of binding.sessionArtifacts) {
      expect(artifact.runtimePath).toMatch(
        new RegExp(`^/tmp/openma-harness-state/acp/session_matrix/${adapterId}/v1/native(?:/|$)`),
      );
      expect(artifact.path).toMatch(
        new RegExp(`^/workspace/\\.openma/harness-state/acp/session_matrix/${adapterId}/v1/native(?:/|$)`),
      );
    }
  });

  it("binds Hermes' SQLite session store through HERMES_HOME", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_hermes",
      agent: { id: "hermes", command: "hermes", args: ["acp"] },
    });

    expect(binding).toMatchObject({
      adapterId: "hermes",
      durability: "native",
      resume: "native-and-acp",
      agent: {
        env: {
          HERMES_HOME:
            "/tmp/openma-harness-state/acp/session_hermes/hermes/v1/native",
        },
      },
    });
  });

  it("does not special-case the removed OpenClaw integration", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_openclaw",
      agent: {
        id: "openclaw",
        command: "openclaw",
        args: ["acp"],
        env: {
          OPENCLAW_STATE_DIR: "/gateway/state",
          OPENCLAW_CONFIG_PATH: "/gateway/openclaw.json",
        },
      },
    });

    expect(binding).toMatchObject({
      adapterId: "opaque",
      durability: "opaque",
      resume: "acp-only",
      agent: {
        env: {
          OPENCLAW_STATE_DIR: "/gateway/state",
          OPENCLAW_CONFIG_PATH: "/gateway/openclaw.json",
        },
      },
    });
  });

  it("does not claim native recovery for an unadapted ACP agent", () => {
    const binding = bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "community-acp", env: { KEEP: "yes" } },
    });

    expect(binding).toMatchObject({
      adapterId: "opaque",
      durability: "opaque",
      resume: "acp-only",
      rootPath:
        "/workspace/.openma/harness-state/acp/session_1/opaque/v1",
      agent: {
        command: "community-acp",
        env: {
          KEEP: "yes",
          OPENMA_ACP_STATE_ROOT:
            "/tmp/openma-harness-state/acp/session_1/opaque/v1",
        },
      },
    });
  });

  it("recognizes legacy wrapper commands when old configs have no agent id", () => {
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "claude-code-acp" },
    }).adapterId).toBe("claude-code");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "codex-acp" },
    }).adapterId).toBe("codex");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "/usr/local/bin/gemini" },
    }).adapterId).toBe("gemini");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "opencode" },
    }).adapterId).toBe("opencode");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "pi-acp" },
    }).adapterId).toBe("pi");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "mcode" },
    }).adapterId).toBe("mcode");
    expect(bindAcpAgentState({
      sessionId: "session_1",
      agent: { command: "hermes" },
    }).adapterId).toBe("hermes");
  });
});
