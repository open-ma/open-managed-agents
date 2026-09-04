import type { AcpSession } from "@open-managed-agents/acp-runtime";
import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import {
  runWithSandboxLease,
  SandboxLeaseLostError,
  supportsDuplexProcess,
  supportsSandboxRuntime,
} from "@open-managed-agents/sandbox";
import type { SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

import { AcpTranslator } from "./acp-translate";
import type {
  HarnessContext,
  HarnessDisposeReason,
  HarnessInterface,
  HarnessRuntime,
} from "./interface";
import {
  bindAcpAgentState,
  type AcpAgentStateBinding,
} from "@open-managed-agents/acp-runtime/native-state";
import {
  buildAcpSemanticRecoveryPrompt,
  type AcpSemanticRecoveryReason,
} from "./acp-recovery";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SANDBOX_LEASE_TTL_MS = 90_000;
const DEFAULT_SANDBOX_HEARTBEAT_MS = 30_000;
interface AcpSandboxCheckpoint {
  version: 1;
  configurationSha256: string;
  acpSessionId: string;
}

/** Runs an ACP-compatible agent inside the session Sandbox while OpenMA keeps
 * ownership of session lifecycle, cancellation and canonical events. */
export class AcpSandboxHarness implements HarnessInterface {
  #session: AcpSession | null = null;
  #configKey: string | null = null;
  #resumeAcpSessionId: string | null = null;
  #checkpointLoadedForKey: string | null = null;
  #runtime: HarnessRuntime | null = null;
  #stateBinding: AcpAgentStateBinding | null = null;
  #semanticRecoveryReason: AcpSemanticRecoveryReason | null = null;

  async onSessionInit(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void> {
    const prompt = ctx.systemPrompt.trimEnd();
    if (prompt) {
      await runtime.sandbox.writeFile("/workspace/AGENTS.md", `${prompt}\n`);
    }
  }

  shouldCompact(): boolean {
    return false;
  }

  async compact(): Promise<void> {}

  deriveModelContext(): never[] {
    return [];
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    this.#runtime = runtime;
    const config = ctx.agent.acp;
    if (!config?.agent?.command) {
      this.#emitError(runtime, "AcpSandboxHarness requires agent.acp.agent.command");
      return;
    }
    if (!supportsDuplexProcess(runtime.sandbox)) {
      this.#emitError(runtime, "selected sandbox does not support duplex ACP processes");
      return;
    }
    if (!ctx.session_id) {
      this.#emitError(runtime, "AcpSandboxHarness requires a session_id for native state isolation");
      return;
    }

    const text = extractUserText(ctx.userMessage);
    if (!text) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    const stateBinding = bindAcpAgentState({
      sessionId: ctx.session_id,
      agent: config.agent,
    });
    const configKey = JSON.stringify({ config, stateAdapter: stateBinding.adapterId });
    await this.#ensureStateBinding(runtime, stateBinding);
    if (!this.#session && this.#checkpointLoadedForKey !== configKey) {
      this.#checkpointLoadedForKey = configKey;
      this.#semanticRecoveryReason = null;
      this.#resumeAcpSessionId = await this.#loadCheckpoint(
        runtime,
        configKey,
        stateBinding.checkpointPath,
      );
    }
    if (this.#session && (this.#configKey !== configKey || !this.#session.isAlive())) {
      this.#resumeAcpSessionId = this.#configKey === configKey
        ? this.#session.acpSessionId || null
        : null;
      await this.#session.dispose();
      this.#session = null;
    }

    if (
      !this.#session &&
      this.#resumeAcpSessionId &&
      stateBinding.resume === "native-and-acp" &&
      !(await this.#hasRequiredNativeState(runtime, stateBinding))
    ) {
      this.#resumeAcpSessionId = null;
      this.#semanticRecoveryReason = "native-state-missing";
    }

    const translator = new AcpTranslator(runtime, {
      model: typeof ctx.agent.model === "string" ? ctx.agent.model : ctx.agent.model.id,
    });
    try {
      if (!this.#session) {
        const acpRuntime = createAcpRuntime({
          type: "sandbox",
          sandbox: runtime.sandbox,
        });
        this.#session = await acpRuntime.start({
          agent: {
            ...stateBinding.agent,
            cwd: stateBinding.agent.cwd ?? "/workspace",
          },
          restart: config.restart
            ? {
                mode: config.restart.mode,
                maxRestarts: config.restart.max_restarts,
                windowMs: config.restart.window_ms,
              }
            : { mode: "on-crash", maxRestarts: 3, windowMs: 60_000 },
          idleTimeoutMs: config.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS,
          perTurnTimeoutMs:
            config.per_turn_timeout_ms ?? DEFAULT_TURN_TIMEOUT_MS,
          ...(this.#resumeAcpSessionId
            ? { resumeAcpSessionId: this.#resumeAcpSessionId }
            : {}),
        });
        this.#configKey = configKey;
        this.#stateBinding = stateBinding;
        this.#resumeAcpSessionId = this.#session.acpSessionId || null;
        await this.#saveCheckpoint(
          runtime,
          configKey,
          this.#session.acpSessionId,
          stateBinding.checkpointPath,
        );
      }

      const session = this.#session;
      const recoveryReason = this.#semanticRecoveryReason;
      const promptText = recoveryReason
        ? buildAcpSemanticRecoveryPrompt(
            runtime.history.getEvents(),
            ctx.userMessage,
            { reason: recoveryReason },
          )
        : text;
      if (recoveryReason) {
        runtime.broadcast({
          type: "session.warning",
          source: "acp_semantic_recovery",
          message: "Agent-native session state was unavailable; continued from canonical OpenMA history.",
          details: {
            reason: recoveryReason,
            adapter_id: stateBinding.adapterId,
          },
        });
      }
      const consumePrompt = async (abortSignal: AbortSignal) => {
        for await (const update of session.prompt(promptText, { abortSignal })) {
          await translator.consumePromptItem(update, session.acpSessionId);
        }
      };
      if (
        supportsSandboxRuntime(runtime.sandbox) &&
        runtime.sandbox.runtimeCapabilities().lease
      ) {
        await runWithSandboxLease(
          runtime.sandbox,
          {
            ttlMs: DEFAULT_SANDBOX_LEASE_TTL_MS,
            intervalMs: DEFAULT_SANDBOX_HEARTBEAT_MS,
            signal: runtime.abortSignal,
          },
          consumePrompt,
        );
      } else {
        const fallbackController = new AbortController();
        const onAbort = () => fallbackController.abort(runtime.abortSignal?.reason);
        if (runtime.abortSignal?.aborted) onAbort();
        else runtime.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          await consumePrompt(fallbackController.signal);
        } finally {
          runtime.abortSignal?.removeEventListener("abort", onAbort);
        }
      }
      await translator.flush(runtime.abortSignal?.aborted ? "aborted" : "completed");
      this.#semanticRecoveryReason = null;
    } catch (error) {
      const leaseLost = error instanceof SandboxLeaseLostError;
      const aborted = leaseLost || (runtime.abortSignal?.aborted ?? false);
      if (leaseLost && this.#session) {
        const fencedSession = this.#session;
        this.#resumeAcpSessionId = fencedSession.acpSessionId || null;
        this.#session = null;
        await fencedSession.dispose().catch(() => undefined);
      }
      await translator.flush(aborted ? "aborted" : "completed");
      if (!runtime.abortSignal?.aborted) {
        this.#emitError(
          runtime,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async dispose(reason: HarnessDisposeReason = "destroy"): Promise<void> {
    const session = this.#session;
    const runtime = this.#runtime;
    const stateBinding = this.#stateBinding;
    this.#session = null;
    this.#configKey = null;
    this.#resumeAcpSessionId = null;
    this.#checkpointLoadedForKey = null;
    this.#runtime = null;
    this.#stateBinding = null;
    this.#semanticRecoveryReason = null;
    await session?.dispose();
    // A host shutdown is a placement change, not logical session deletion.
    // Keep the native ACP id and session artifacts in /workspace so a
    // replacement host can resume after restoring the provider filesystem
    // checkpoint. Explicit logical destruction or harness replacement removes
    // the complete isolated session root; configuration and cache files must
    // not outlive the session merely because the agent wrote them beside its
    // native transcript.
    if (reason !== "shutdown" && stateBinding) {
      await runtime?.sandbox.exec(
        `rm -rf -- ${shellQuote(sandboxShellPath(stateBinding.rootPath))}`,
      )
        .catch(() => undefined);
    }
  }

  async #loadCheckpoint(
    runtime: HarnessRuntime,
    configKey: string,
    checkpointPath: string,
  ): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runtime.sandbox.readFile(checkpointPath));
    } catch {
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { configurationSha256?: unknown }).configurationSha256 !== "string" ||
      typeof (parsed as { acpSessionId?: unknown }).acpSessionId !== "string" ||
      (parsed as { acpSessionId: string }).acpSessionId.length === 0
    ) return null;
    const expected = await configurationDigest(configKey);
    return (parsed as AcpSandboxCheckpoint).configurationSha256 === expected
      ? (parsed as AcpSandboxCheckpoint).acpSessionId
      : null;
  }

  async #saveCheckpoint(
    runtime: HarnessRuntime,
    configKey: string,
    acpSessionId: string,
    checkpointPath: string,
  ): Promise<void> {
    if (!acpSessionId) return;
    const checkpoint: AcpSandboxCheckpoint = {
      version: 1,
      configurationSha256: await configurationDigest(configKey),
      acpSessionId,
    };
    await runtime.sandbox.writeFile(
      checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
    );
  }

  async #ensureStateBinding(
    runtime: HarnessRuntime,
    binding: AcpAgentStateBinding,
  ): Promise<void> {
    await runtime.sandbox.writeFile(
      `${binding.rootPath}/session-binding.json`,
      `${JSON.stringify({
        version: 1,
        adapter_id: binding.adapterId,
        durability: binding.durability,
        resume: binding.resume,
        session_artifacts: binding.sessionArtifacts,
      })}\n`,
    );
  }

  async #hasRequiredNativeState(
    runtime: HarnessRuntime,
    binding: AcpAgentStateBinding,
  ): Promise<boolean> {
    const required = binding.sessionArtifacts.filter(
      (artifact) => artifact.requiredForResume,
    );
    if (required.length === 0) return true;
    for (const artifact of required) {
      const predicate = artifact.kind === "directory" ? "-d" : "-f";
      // Relative-to-/workspace paths work in real sandbox containers and in
      // LocalSubprocessSandbox, whose shell cwd is the host-backed workspace.
      // Its exec() intentionally cannot rewrite paths embedded in shell text.
      const path = sandboxShellPath(artifact.path);
      try {
        const result = await runtime.sandbox.exec(
          `if [ ${predicate} ${shellQuote(path)} ]; then printf present; else printf missing; fi`,
        );
        if (result.trim() !== "present") return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sandboxShellPath(path: string): string {
  return path.startsWith("/workspace/")
    ? path.slice("/workspace/".length)
    : path;
}

async function configurationDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function extractUserText(message: UserMessageEvent): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
