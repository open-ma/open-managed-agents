import type {
  AcpSession,
  SessionOptions,
} from "@open-managed-agents/acp-runtime";

interface AcpSessionFixtureOptions {
  acpSessionId: string;
  options?: SessionOptions;
  isAlive?(): boolean;
  supportsSteering?: boolean;
  steer?(input: string): ReturnType<AcpSession["steer"]>;
  prompt?(
    input: string,
    options?: { abortSignal?: AbortSignal },
  ): AsyncIterable<unknown>;
  dispose?(): Promise<void>;
}

function unsupported(name: string): Promise<never> {
  return Promise.reject(new Error(`unused ACP fixture method: ${name}`));
}

export function acpSessionFixture(
  fixture: AcpSessionFixtureOptions,
): AcpSession {
  const options = fixture.options ?? { agent: { command: "test-acp" } };
  return {
    id: `host-${fixture.acpSessionId}`,
    acpSessionId: fixture.acpSessionId,
    options,
    authMethods: [],
    protocolVersion: null,
    agentInfo: null,
    agentCapabilities: {},
    initializeMeta: null,
    sessionSetupMeta: null,
    configOptions: [],
    modes: null,
    promptCapabilities: {},
    supportsSessionFork: false,
    supportsSessionList: false,
    supportsSessionDelete: false,
    supportsSessionResume: false,
    supportsSessionClose: false,
    supportsAdditionalDirectories: false,
    supportsLogout: false,
    supportsProviders: false,
    supportsNes: false,
    nesCapabilities: null,
    positionEncoding: null,
    // Steering is part of the OpenMA ACP harness contract. Tests opt out only
    // when they are exercising the fail-closed conformance boundary.
    supportsSteering: fixture.supportsSteering ?? true,
    prompt(input, promptOptions) {
      if (typeof input !== "string") {
        throw new Error("ACP fixture only accepts text prompts");
      }
      return fixture.prompt?.(input, promptOptions) ?? (async function* () {})();
    },
    steer(input) {
      if (typeof input !== "string") {
        throw new Error("ACP fixture only accepts text steering input");
      }
      return fixture.steer?.(input) ?? Promise.resolve("failed");
    },
    async cancelCurrentTurn() {},
    drainPendingEvents() { return []; },
    async setConfigOption() { return []; },
    async authenticate() {},
    async setMode() {},
    async listSessions() { return unsupported("listSessions"); },
    async deleteSession() {},
    async logout() {},
    async listProviders() { return unsupported("listProviders"); },
    async setProvider() {},
    async disableProvider() {},
    async requestExtension() { return unsupported("requestExtension"); },
    async notifyExtension() {},
    async startNes() { return unsupported("startNes"); },
    async suggestNes() { return unsupported("suggestNes"); },
    async closeNes() {},
    async didOpenDocument() {},
    async didChangeDocument() {},
    async didCloseDocument() {},
    async didSaveDocument() {},
    async didFocusDocument() {},
    async acceptNes() {},
    async rejectNes() {},
    isAlive: fixture.isAlive ?? (() => true),
    dispose: fixture.dispose ?? (async () => {}),
  };
}
