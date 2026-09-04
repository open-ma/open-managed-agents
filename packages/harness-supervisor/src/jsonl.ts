import type {
  HarnessSupervisorCommand,
  RuntimeResourceScope,
} from "@open-managed-agents/runtime-resource-contract";

import {
  createHarnessSupervisor,
  type HarnessSupervisorHarness,
  type HarnessSupervisorScheduler,
} from "./index";

export interface HarnessSupervisorJsonlOptions {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  heartbeatIntervalMs: number;
  resolveHarness(
    harness: { id: string; version: string },
  ): Promise<HarnessSupervisorHarness | null>;
  scheduler?: HarnessSupervisorScheduler;
}

/**
 * Serves the enhanced in-sandbox supervisor protocol over newline-delimited
 * JSON. Standard Web Streams keep the protocol reusable by Node stdio,
 * provider SDK process streams, and workerd without importing a platform.
 */
export async function serveHarnessSupervisorJsonl(
  options: HarnessSupervisorJsonlOptions,
): Promise<void> {
  const reader = options.input.getReader();
  const writer = options.output.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let failed = false;
  const writeEvent = async (event: unknown) => {
    await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  };
  const supervisor = createHarnessSupervisor({
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    resolveHarness: options.resolveHarness,
    emit: writeEvent,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });

  const dispatchLine = async (line: string) => {
    if (line.trim().length === 0) return;
    await supervisor.dispatch(parseCommand(line));
  };

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await dispatchLine(line);
      }
    }
    buffer += decoder.decode();
    await dispatchLine(buffer);
  } catch (error) {
    failed = true;
    await writeEvent({ type: "error", message: normalizeError(error).message }).catch(() => {});
    throw error;
  } finally {
    await supervisor.close().catch(() => {});
    reader.releaseLock();
    await writer.close().catch(() => {});
    writer.releaseLock();
    if (failed) await options.input.cancel().catch(() => {});
  }
}

function parseCommand(line: string): HarnessSupervisorCommand {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Harness supervisor command is invalid JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Harness supervisor command must be an object with a type");
  }
  if (value.type === "drain") return { type: "drain" };
  if (value.type === "stop") {
    if (value.reason !== "aborted" && value.reason !== "failed") {
      throw new Error("Harness supervisor stop reason must be aborted or failed");
    }
    return { type: "stop", reason: value.reason };
  }
  if (value.type !== "start") {
    throw new Error(`Unknown harness supervisor command: ${value.type}`);
  }
  if (!isScope(value.scope)) {
    throw new Error("Harness supervisor start scope is invalid");
  }
  if (
    !isRecord(value.harness)
    || !isNonEmptyString(value.harness.id)
    || !isNonEmptyString(value.harness.version)
  ) {
    throw new Error("Harness supervisor start harness is invalid");
  }
  if (value.workspacePath !== "/workspace") {
    throw new Error("Harness supervisor workspacePath must be /workspace");
  }
  if (value.outputPath !== null && value.outputPath !== "/mnt/session/outputs") {
    throw new Error("Harness supervisor outputPath is invalid");
  }
  return {
    type: "start",
    scope: value.scope,
    harness: { id: value.harness.id, version: value.harness.version },
    workspacePath: value.workspacePath,
    outputPath: value.outputPath,
  };
}

function isScope(value: unknown): value is RuntimeResourceScope {
  return isRecord(value)
    && isNonEmptyString(value.workspaceId)
    && isNonEmptyString(value.environmentId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.workId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
