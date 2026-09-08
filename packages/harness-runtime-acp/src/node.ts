import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  AcpStatefulAgentSpec,
} from "@open-managed-agents/acp-runtime/native-state";
import {
  captureAcpSandboxAgentState,
  hasRequiredAcpSandboxAgentState,
  materializeAcpSandboxAgentState,
  prepareAcpSandboxAgent,
  releaseAcpSandboxAgentState,
  restoreAcpSandboxAgentState,
  type AcpSandboxAgentPreparation,
  type AcpSandboxAgentStatePort,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import type { SessionOptions } from "@open-managed-agents/acp-runtime";
import type {
  SessionHostEvent,
  SessionStartCommand,
} from "@openma/common/session-kernel";

import type {
  ManagedHarnessSessionStartCommand,
  ManagedHarnessSessionStatePort,
  ManagedHarnessSessionStatePreparation,
} from "./index.js";

export interface NodeAcpHarnessStateIo extends AcpSandboxAgentStatePort {
  readFile(path: string): Promise<string>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
}

export interface NodeAcpHarnessStateIoOptions {
  /** Actual path mounted at the protocol-level `/workspace`. */
  workspacePath?: string;
}

/** Node filesystem/process adapter used from inside Docker, MicroVMs and
 * other Node-capable sandbox images. It contains no durable-store logic. */
export function createNodeAcpHarnessStateIo(
  options: NodeAcpHarnessStateIoOptions = {},
): NodeAcpHarnessStateIo {
  const workspacePath = options.workspacePath ?? "/workspace";
  const resolveProtocolPath = (path: string): string => {
    if (path === "/workspace") return workspacePath;
    if (path.startsWith("/workspace/")) {
      return join(workspacePath, path.slice("/workspace/".length));
    }
    return path;
  };
  return {
    async readFile(path) {
      return readFile(resolveProtocolPath(path), "utf8");
    },
    async writeFile(path, content) {
      const resolved = resolveProtocolPath(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async writeFileBytes(path, content) {
      const resolved = resolveProtocolPath(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
    },
    async exec(command) {
      const result = await promisify(execFile)("/bin/sh", ["-c", command], {
        cwd: workspacePath,
        maxBuffer: 16 * 1024 * 1024,
      });
      return result.stdout;
    },
  };
}

export interface AcpHarnessResolvedSession {
  agent: AcpStatefulAgentSpec;
  restart?: SessionOptions["restart"];
  idleTimeoutMs?: number;
  perTurnTimeoutMs?: number;
  mcpServers?: SessionOptions["mcpServers"];
  additionalDirectories?: string[];
  sessionRequestMeta?: Record<string, unknown>;
}

export interface AcpNativeSessionStateOptions {
  io: NodeAcpHarnessStateIo;
  resolveSession(
    command: SessionStartCommand,
  ): Promise<AcpHarnessResolvedSession>;
}

interface NativeStateRecord {
  preparation: AcpSandboxAgentPreparation;
  options: AcpHarnessResolvedSession;
  resumeAcpSessionId?: string;
  lastCompletedTurnId?: string;
}

interface NativeCheckpointV1 {
  version: 1;
  adapter_id: string;
  acp_session_id: string;
  last_completed_turn_id?: string;
}

/**
 * OpenMA-owned native Session persistence for a whole-brain ACP runtime.
 *
 * Harbor informs only `prepareAcpSandboxAgent()`'s per-agent artifact list.
 * This object owns restore timing, checkpoint creation, stale-resume rejection
 * and deletion semantics and is intentionally independent of any provider SDK.
 */
export class AcpNativeSessionState implements ManagedHarnessSessionStatePort {
  readonly #records = new Map<string, NativeStateRecord>();

  constructor(private readonly options: AcpNativeSessionStateOptions) {}

  async beforeStart(
    command: ManagedHarnessSessionStartCommand,
  ): Promise<ManagedHarnessSessionStatePreparation> {
    const { canonicalCompletedTurnId, ...sessionCommand } = command;
    const resolved = await this.options.resolveSession(sessionCommand);
    const preparation = prepareAcpSandboxAgent({
      sessionId: sessionCommand.sessionId,
      agent: resolved.agent,
    });
    await materializeAcpSandboxAgentState(this.options.io, preparation);
    const checkpoint = await this.#readCheckpoint(preparation);
    const resumeAcpSessionId = checkpoint?.acp_session_id
      ?? sessionCommand.acpSessionId;
    let semanticRecoveryReason: ManagedHarnessSessionStatePreparation["semanticRecoveryReason"];
    let usableResumeId = resumeAcpSessionId;
    if (canonicalCompletedTurnId !== undefined
      && checkpoint?.last_completed_turn_id !== canonicalCompletedTurnId) {
      usableResumeId = undefined;
      semanticRecoveryReason = "native-state-stale";
    } else if (
      resumeAcpSessionId !== undefined
      && preparation.binding.resume === "native-and-acp"
    ) {
      if (await hasRequiredAcpSandboxAgentState(this.options.io, preparation)) {
        await restoreAcpSandboxAgentState(this.options.io, preparation);
      } else {
        usableResumeId = undefined;
        semanticRecoveryReason = "native-state-missing";
      }
    }
    this.#records.set(sessionCommand.sessionId, {
      preparation,
      options: resolved,
      ...(checkpoint?.last_completed_turn_id === undefined
        ? {}
        : { lastCompletedTurnId: checkpoint.last_completed_turn_id }),
      ...(usableResumeId === undefined
        ? {}
        : { resumeAcpSessionId: usableResumeId }),
    });
    const preparedCommand: SessionStartCommand = usableResumeId === undefined
      ? (resumeAcpSessionId === undefined
        ? sessionCommand
        : { ...sessionCommand, acpSessionId: undefined })
      : { ...sessionCommand, acpSessionId: usableResumeId };
    return {
      command: preparedCommand,
      ...(semanticRecoveryReason === undefined ? {} : { semanticRecoveryReason }),
    };
  }

  async prepare(command: SessionStartCommand): Promise<SessionOptions> {
    const record = this.#records.get(command.sessionId);
    if (record === undefined) {
      throw new Error(
        `ACP native state for ${command.sessionId} was not prepared before start`,
      );
    }
    const resolved = record.options;
    return {
      agent: record.preparation.launch,
      ...(resolved.restart === undefined ? {} : { restart: resolved.restart }),
      ...(resolved.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: resolved.idleTimeoutMs }),
      ...(resolved.perTurnTimeoutMs === undefined
        ? {}
        : { perTurnTimeoutMs: resolved.perTurnTimeoutMs }),
      ...(resolved.mcpServers === undefined ? {} : { mcpServers: resolved.mcpServers }),
      ...(resolved.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: resolved.additionalDirectories }),
      ...(resolved.sessionRequestMeta === undefined
        ? {}
        : { sessionRequestMeta: resolved.sessionRequestMeta }),
      ...(command.acpSessionId === undefined
        ? {}
        : { resumeAcpSessionId: command.acpSessionId }),
    };
  }

  async onReady(
    event: Extract<SessionHostEvent, { type: "session.ready" }>,
  ): Promise<void> {
    const record = this.#requireRecord(event.sessionId);
    const checkpoint: NativeCheckpointV1 = {
      version: 1,
      adapter_id: record.preparation.binding.adapterId,
      acp_session_id: event.acpSessionId,
      ...(record.lastCompletedTurnId === undefined
        ? {}
        : { last_completed_turn_id: record.lastCompletedTurnId }),
    };
    await this.options.io.writeFile(
      record.preparation.binding.checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
    );
    record.resumeAcpSessionId = event.acpSessionId;
  }

  async checkpoint(input: { sessionId: string; turnId?: string }): Promise<void> {
    const record = this.#requireRecord(input.sessionId);
    if (record.resumeAcpSessionId === undefined) {
      throw new Error(`ACP native state for ${input.sessionId} is not ready`);
    }
    if (input.turnId !== undefined) record.lastCompletedTurnId = input.turnId;
    const checkpoint: NativeCheckpointV1 = {
      version: 1,
      adapter_id: record.preparation.binding.adapterId,
      acp_session_id: record.resumeAcpSessionId,
      ...(record.lastCompletedTurnId === undefined
        ? {}
        : { last_completed_turn_id: record.lastCompletedTurnId }),
    };
    // The marker is advanced before copying artifacts. If capture crashes,
    // canonical history still has the older watermark and recovery rejects
    // this candidate. Publication happens only after capture succeeds.
    await this.options.io.writeFile(
      record.preparation.binding.checkpointPath,
      `${JSON.stringify(checkpoint)}\n`,
    );
    await captureAcpSandboxAgentState(this.options.io, record.preparation);
  }

  async release(input: {
    sessionId: string;
    reason: "shutdown" | "destroy";
  }): Promise<void> {
    const record = this.#requireRecord(input.sessionId);
    await releaseAcpSandboxAgentState(
      this.options.io,
      record.preparation,
      input.reason === "destroy" ? "destroy" : "shutdown",
    );
    this.#records.delete(input.sessionId);
  }

  async #readCheckpoint(
    preparation: AcpSandboxAgentPreparation,
  ): Promise<NativeCheckpointV1 | null> {
    try {
      const value = JSON.parse(
        await this.options.io.readFile(preparation.binding.checkpointPath),
      ) as Partial<NativeCheckpointV1>;
      if (
        value.version !== 1
        || value.adapter_id !== preparation.binding.adapterId
        || typeof value.acp_session_id !== "string"
        || value.acp_session_id.length === 0
        || (value.last_completed_turn_id !== undefined
          && (typeof value.last_completed_turn_id !== "string"
            || value.last_completed_turn_id.length === 0))
      ) return null;
      return value as NativeCheckpointV1;
    } catch {
      return null;
    }
  }

  #requireRecord(sessionId: string): NativeStateRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined) {
      throw new Error(`ACP native state for ${sessionId} is not active`);
    }
    return record;
  }
}

export function createAcpNativeSessionState(
  options: AcpNativeSessionStateOptions,
): AcpNativeSessionState {
  return new AcpNativeSessionState(options);
}
