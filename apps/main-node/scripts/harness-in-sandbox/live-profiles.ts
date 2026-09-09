import { join } from "node:path";

export const LIVE_HARNESS_IDS = ["codex-acp", "mcode"] as const;

export type LiveHarnessId = (typeof LIVE_HARNESS_IDS)[number];

export interface LiveHarnessCredentialMount {
  source: string;
  destination: string;
}

export interface LiveHarnessCredentialLink {
  path: string;
  target: string;
}

export interface LiveHarnessProfile {
  id: LiveHarnessId;
  command: string;
  args: string[];
  image: string;
  fixture: string;
  env: Record<string, string>;
  nativeArtifactPaths: string[];
  sessionConfigOptions: Array<{ id: string; value: string | boolean }>;
  defaultModelOverride: string | null;
  skillDirectory: string;
  credentialLinks: LiveHarnessCredentialLink[];
  credentialMounts(home: string): LiveHarnessCredentialMount[];
}

export function buildTrustEnvironment(bundlePath: string): Record<string, string> {
  return {
    NODE_EXTRA_CA_CERTS: bundlePath,
    SSL_CERT_FILE: bundlePath,
  };
}

export function buildMcodeDeepSeekConfig(apiKey: string): string {
  if (!apiKey.trim()) throw new Error("DeepSeek API key is required for MCode live certification");
  return [
    "logLevel: info",
    "provider:",
    "  deepseek:",
    "    npm: '@ai-sdk/openai'",
    "    options:",
    `      apiKey: ${JSON.stringify(apiKey)}`,
    "      baseURL: https://api.deepseek.com",
    "    models:",
    "      deepseek-v4-flash:",
    "        name: DeepSeek V4 Flash",
    "        attachment: false",
    "        reasoning: false",
    "        temperature: true",
    "        tool_call: true",
    "        limit:",
    "          context: 131072",
    "          output: 8192",
    "defaultModel: deepseek/deepseek-v4-flash",
    "permissionMode: bypassPermissions",
    "",
  ].join("\n");
}

export function getLiveHarnessProfile(
  harnessId: string,
  nativeRoot: string,
): LiveHarnessProfile {
  if (harnessId === "codex-acp") {
    return {
      id: harnessId,
      command: "codex-acp",
      args: [],
      image: "openma/codex-acp-certification:1.8.0",
      fixture: "codex-acp-sandbox",
      env: { CODEX_HOME: nativeRoot },
      nativeArtifactPaths: ["sessions"],
      sessionConfigOptions: [],
      defaultModelOverride: null,
      skillDirectory: "/workspace/.agents/skills/openma-certification",
      credentialLinks: [{
        path: `${nativeRoot}/auth.json`,
        target: "/run/openma-credentials/codex-auth.json",
      }],
      credentialMounts: (home) => [{
        source: join(home, ".codex", "auth.json"),
        destination: "/run/openma-credentials/codex-auth.json",
      }],
    };
  }
  if (harnessId === "mcode") {
    return {
      id: harnessId,
      command: "mcode",
      args: ["acp"],
      image: "openma/mcode-acp-certification:0.3.1",
      fixture: "mcode-acp-sandbox",
      env: { MINIMAX_DATA_DIR: nativeRoot },
      nativeArtifactPaths: [
        "v2/sessions",
        "v2/sqlite/runtime-state.sqlite",
      ],
      sessionConfigOptions: [],
      defaultModelOverride: "deepseek/deepseek-v4-flash",
      skillDirectory: `${nativeRoot}/skills/openma-certification`,
      credentialLinks: [
        {
          path: `${nativeRoot}/config.yaml`,
          target: "/run/openma-credentials/mcode-config.yaml",
        },
      ],
      credentialMounts: () => [],
    };
  }
  throw new Error(`Harness ${harnessId} is not in the live harness-in-sandbox matrix`);
}
