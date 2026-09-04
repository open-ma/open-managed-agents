import { describe, expect, it } from "vitest";

import {
  ACP_NATIVE_STATE_PROFILES,
  HARBOR_NATIVE_STATE_COVERAGE,
  bindAcpAgentState,
} from "./native-state.js";

describe("Harbor-compatible ACP native session profiles", () => {
  it("classifies Harbor resume agents without pretending non-ACP CLIs are runnable", () => {
    expect(HARBOR_NATIVE_STATE_COVERAGE).toEqual([
      { harborId: "aider", status: "acp-adapter", profileId: "aider" },
      { harborId: "claude-code", status: "native-resume", profileId: "claude-code" },
      { harborId: "codex", status: "native-resume", profileId: "codex" },
      { harborId: "copilot-cli", status: "native-resume", profileId: "copilot" },
      { harborId: "cortex-code", status: "native-resume", profileId: "cortex-code" },
      { harborId: "gemini-cli", status: "native-resume", profileId: "gemini" },
      { harborId: "goose", status: "native-resume", profileId: "goose" },
      { harborId: "junie", status: "native-resume", profileId: "junie" },
      { harborId: "kimi-cli", status: "native-resume", profileId: "kimi" },
      { harborId: "kimi-code", status: "acp-adapter", profileId: "kimi-code" },
      { harborId: "mcode", status: "native-resume", profileId: "mcode" },
      { harborId: "mimo", status: "acp-adapter", profileId: "mimo" },
      { harborId: "opencode", status: "native-resume", profileId: "opencode" },
      { harborId: "pi", status: "native-resume", profileId: "pi" },
      { harborId: "qwen-code", status: "native-resume", profileId: "qwen-code" },
      { harborId: "vibe", status: "native-capture", profileId: "mistral-vibe" },
    ]);

    const coveredProfiles = new Set(
      HARBOR_NATIVE_STATE_COVERAGE.flatMap((entry) =>
        "profileId" in entry ? [entry.profileId] : []
      ),
    );
    expect(coveredProfiles).toEqual(new Set(
      ACP_NATIVE_STATE_PROFILES
        .filter((profile) => HARBOR_NATIVE_STATE_COVERAGE.some((entry) =>
          "profileId" in entry && entry.profileId === profile.id,
        ))
        .map((profile) => profile.id),
    ));
  });

  it("publishes only the per-agent native session artifacts", () => {
    const pi = bindAcpAgentState({
      sessionId: "session_pi",
      agent: { id: "pi-acp", command: "pi-acp" },
    });
    expect(pi).not.toHaveProperty("captureRoot");
    expect(pi).not.toHaveProperty("captureExcludeGlobs");
    expect(pi).not.toHaveProperty("resumeProbes");
    expect(pi).toHaveProperty("sessionArtifacts", [
      {
        path: "/workspace/.openma/harness-state/acp/session_pi/pi/v1/native/home/.pi/agent/sessions",
        kind: "directory",
        requiredForResume: true,
      },
      {
        path: "/workspace/.openma/harness-state/acp/session_pi/pi/v1/native/home/.pi/pi-acp/session-map.json",
        kind: "file",
        requiredForResume: true,
      },
    ]);

    const mcode = bindAcpAgentState({
      sessionId: "session_mcode",
      agent: { id: "mcode", command: "mcode", args: ["acp"] },
    });
    expect(mcode).toHaveProperty("sessionArtifacts", [
      expect.objectContaining({ kind: "directory", requiredForResume: true }),
      expect.objectContaining({
        path: expect.stringMatching(/\/v2\/sqlite\/runtime-state\.sqlite$/),
        kind: "sqlite",
        requiredForResume: true,
      }),
      expect.objectContaining({
        path: expect.stringMatching(/\/v2\/sqlite\/session-index\.sqlite$/),
        kind: "sqlite",
        requiredForResume: true,
      }),
    ]);
  });

  it("uses SQLite-family semantics for session DBs whose WAL and SHM files must travel together", () => {
    for (const agent of [
      { id: "github-copilot-cli", command: "copilot" },
      { id: "mcode", command: "mcode" },
      { id: "hermes", command: "hermes" },
    ]) {
      const binding = bindAcpAgentState({ sessionId: "sqlite", agent });
      expect((binding as unknown as {
        sessionArtifacts: Array<{ kind: string }>;
      }).sessionArtifacts.some((artifact) => artifact.kind === "sqlite")).toBe(true);
    }
  });

  it("keeps OMA extensions distinct from profiles proven by Harbor", () => {
    expect(ACP_NATIVE_STATE_PROFILES.filter((profile) => profile.provenance === "oma"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "aider", durability: "acp", resume: "acp-only" }),
        expect.objectContaining({ id: "kimi-code", durability: "acp", resume: "acp-only" }),
        expect.objectContaining({ id: "mimo", durability: "acp", resume: "acp-only" }),
        expect.objectContaining({ id: "dsh", resume: "native-and-acp" }),
        expect.objectContaining({ id: "hermes", resume: "native-and-acp" }),
      ]));
  });

  it.each([
    ["aider", "aider-acp"],
    ["kimi-code", "kimi-code-acp"],
    ["mimo", "mimo-acp"],
  ])("materializes the %s ACP-only profile without native artifacts", (adapterId, agentId) => {
    const profile = ACP_NATIVE_STATE_PROFILES.find((candidate) => candidate.id === adapterId);
    expect(profile).toBeDefined();
    expect(profile?.matches({ id: agentId, command: agentId })).toBe(true);
    expect(profile?.bindEnvironment("/checkpoint/native")).toEqual({});
    expect(profile?.sessionArtifacts("/checkpoint/native")).toEqual([]);
  });

  it("isolates the DSH ACP JSONL session root for portable native resume", () => {
    const binding = bindAcpAgentState({
      sessionId: "deepseek/session",
      agent: { id: "dsh-acp", command: "dsh-acp" },
    });

    expect(binding).toMatchObject({
      adapterId: "dsh",
      durability: "native",
      resume: "native-and-acp",
      sessionArtifacts: [{
        path: expect.stringMatching(/\/dsh\/v1\/native\/sessions$/),
        kind: "directory",
        requiredForResume: true,
      }],
      agent: {
        env: {
          DSH_HOME: expect.stringMatching(/\/dsh\/v1\/native$/),
          DSH_SESSION_ROOT: expect.stringMatching(/\/dsh\/v1\/native\/sessions$/),
        },
      },
    });
  });

  it.each([
    ["claude-acp", "claude-code"],
    ["codex-acp", "codex"],
    ["gemini", "gemini"],
    ["opencode", "opencode"],
    ["pi-acp", "pi"],
    ["mcode", "mcode"],
    ["github-copilot-cli", "copilot"],
    ["cortex-code", "cortex-code"],
    ["goose", "goose"],
    ["junie", "junie"],
    ["kimi", "kimi"],
    ["qwen-code", "qwen-code"],
    ["mistral-vibe", "mistral-vibe"],
    ["dsh-acp", "dsh"],
    ["hermes", "hermes"],
  ])("materializes the %s session profile inside its checkpoint", (id, adapterId) => {
    const binding = bindAcpAgentState({
      sessionId: "profile/session",
      agent: { id, command: "registry-command", env: { KEEP: "yes" } },
    });

    expect(binding.adapterId).toBe(adapterId);
    expect(binding.durability).toBe("native");
    expect(binding.agent.env).toMatchObject({
      KEEP: "yes",
      OPENMA_ACP_STATE_ROOT: expect.stringContaining("profile%2Fsession"),
    });
    const sessionArtifacts = (binding as unknown as {
      sessionArtifacts: Array<{ path: string }>;
    }).sessionArtifacts;
    expect(sessionArtifacts.length).toBeGreaterThan(0);
    expect(sessionArtifacts.every((artifact) =>
      artifact.path.startsWith(binding.nativePath)
    )).toBe(true);
  });

  it("falls back to an opaque ACP-only binding and recognizes a legacy command path", () => {
    expect(bindAcpAgentState({
      sessionId: "legacy",
      agent: { command: "/usr/local/bin/claude-code-acp" },
    }).adapterId).toBe("claude-code");

    const opaque = bindAcpAgentState({
      sessionId: "community",
      agent: { command: "community-acp" },
    });
    expect(opaque).toMatchObject({
      adapterId: "opaque",
      durability: "opaque",
      resume: "acp-only",
      sessionArtifacts: [],
    });
  });
});
