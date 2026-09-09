import { describe, expect, it } from "vitest";

import {
  buildMcodeDeepSeekConfig,
  buildTrustEnvironment,
  getLiveHarnessProfile,
  LIVE_HARNESS_IDS,
} from "../scripts/harness-in-sandbox/live-profiles";

describe("live harness-in-sandbox profiles", () => {
  it("keeps the supported real matrix explicit", () => {
    expect(LIVE_HARNESS_IDS).toEqual(["codex-acp", "mcode"]);
  });

  it("wires one ephemeral host trust bundle for Node and native TLS clients", () => {
    expect(buildTrustEnvironment("/run/openma-trust/ca.pem")).toEqual({
      NODE_EXTRA_CA_CERTS: "/run/openma-trust/ca.pem",
      SSL_CERT_FILE: "/run/openma-trust/ca.pem",
    });
  });

  it("isolates Codex native state and credentials", () => {
    const profile = getLiveHarnessProfile("codex-acp", "/workspace/native/codex");
    expect(profile).toMatchObject({
      command: "codex-acp",
      args: [],
      image: "openma/codex-acp-certification:1.8.0",
      env: { CODEX_HOME: "/workspace/native/codex" },
      nativeArtifactPaths: ["sessions"],
      sessionConfigOptions: [],
      defaultModelOverride: null,
    });
    expect(profile.credentialMounts("/home/tester")).toEqual([
      {
        source: "/home/tester/.codex/auth.json",
        destination: "/run/openma-credentials/codex-auth.json",
      },
    ]);
    expect(profile.credentialLinks).toEqual([
      {
        path: "/workspace/native/codex/auth.json",
        target: "/run/openma-credentials/codex-auth.json",
      },
    ]);
  });

  it("isolates MCode native state and credentials", () => {
    const profile = getLiveHarnessProfile("mcode", "/workspace/native/mcode");
    expect(profile).toMatchObject({
      command: "mcode",
      args: ["acp"],
      image: "openma/mcode-acp-certification:0.3.1",
      env: { MINIMAX_DATA_DIR: "/workspace/native/mcode" },
      nativeArtifactPaths: [
        "v2/sessions",
        "v2/sqlite/runtime-state.sqlite",
      ],
      sessionConfigOptions: [],
      defaultModelOverride: "deepseek/deepseek-v4-flash",
    });
    expect(profile.credentialMounts("/home/tester")).toEqual([]);
    expect(profile.credentialLinks).toEqual([
      {
        path: "/workspace/native/mcode/config.yaml",
        target: "/run/openma-credentials/mcode-config.yaml",
      },
    ]);
  });

  it("builds an ephemeral MCode DeepSeek provider without logging or persisting the key", () => {
    const config = buildMcodeDeepSeekConfig("fixture-deepseek-secret");
    expect(config).toContain("defaultModel: deepseek/deepseek-v4-flash");
    expect(config).toContain("baseURL: https://api.deepseek.com");
    expect(config).toContain("npm: '@ai-sdk/openai'");
    expect(config.match(/fixture-deepseek-secret/g)).toHaveLength(1);
  });

  it("quotes MCode DeepSeek credentials as a safe YAML scalar", () => {
    const config = buildMcodeDeepSeekConfig('line-one\n"line-two": # value');
    expect(config).toContain('apiKey: "line-one\\n\\\"line-two\\\": # value"');
  });

  it("fails closed for a harness outside the certified matrix", () => {
    expect(() => getLiveHarnessProfile("hermes", "/workspace/native/hermes"))
      .toThrow(/not in the live harness-in-sandbox matrix/i);
  });
});
