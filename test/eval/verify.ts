import type { SSEEvent, VerifyResult } from "./types.js";

// ---- Low-level event helpers ----

/** Get all events of a specific type */
export function eventsOfType(events: SSEEvent[], type: string): SSEEvent[] {
  return events.filter((e) => e.type === type);
}

/** Get all tool_use events */
export function toolUseEvents(events: SSEEvent[]): SSEEvent[] {
  return eventsOfType(events, "agent.tool_use");
}

/** Get all tool_result events */
export function toolResultEvents(events: SSEEvent[]): SSEEvent[] {
  return eventsOfType(events, "agent.tool_result");
}

/** Find the tool_result matching a tool_use id */
export function findToolResult(events: SSEEvent[], toolUseId: string): SSEEvent | undefined {
  return events.find((e) => e.type === "agent.tool_result" && e.tool_use_id === toolUseId);
}

/** Get the text content from an agent.message event */
export function getMessageText(event: SSEEvent): string {
  if (!Array.isArray(event.content)) return "";
  return event.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text || "")
    .join("");
}

/** Get tool result content as string */
export function getToolResultContent(events: SSEEvent[], toolUseId: string): string {
  const result = findToolResult(events, toolUseId);
  return typeof result?.content === "string" ? result.content : "";
}

// ---- Assertion helpers (return VerifyResult) ----

function pass(msg: string): VerifyResult {
  return { status: "pass", message: msg };
}

function fail(msg: string, details?: string[]): VerifyResult {
  return { status: "fail", message: msg, details };
}

/** Assert a specific tool was used at least once */
export function assertToolUsed(events: SSEEvent[], toolName: string): VerifyResult {
  const uses = toolUseEvents(events).filter((e) => e.name === toolName);
  return uses.length > 0
    ? pass(`Tool "${toolName}" used ${uses.length} time(s)`)
    : fail(`Tool "${toolName}" was never used`);
}

/** Assert a tool was NOT used */
export function assertToolNotUsed(events: SSEEvent[], toolName: string): VerifyResult {
  const uses = toolUseEvents(events).filter((e) => e.name === toolName);
  return uses.length === 0
    ? pass(`Tool "${toolName}" correctly not used`)
    : fail(`Tool "${toolName}" was used ${uses.length} time(s) but should not have been`);
}

/** Assert any tool_result for a given tool name contains a substring */
export function assertToolResultContains(
  events: SSEEvent[],
  toolName: string,
  substring: string,
): VerifyResult {
  const uses = toolUseEvents(events).filter((e) => e.name === toolName);
  for (const use of uses) {
    const content = getToolResultContent(events, use.id!);
    if (content.includes(substring)) {
      return pass(`Tool "${toolName}" result contains "${substring}"`);
    }
  }
  return fail(`No "${toolName}" tool result contains "${substring}"`, [
    `Found ${uses.length} "${toolName}" calls`,
    ...uses.map((u) => {
      const c = getToolResultContent(events, u.id!);
      return `  result preview: ${c.slice(0, 200)}`;
    }),
  ]);
}

/** Assert a bash tool result has a specific exit code (parsed from "exit=N") */
export function assertBashExitCode(events: SSEEvent[], expectedCode: number): VerifyResult {
  const bashUses = toolUseEvents(events).filter((e) => e.name === "bash");
  for (const use of bashUses) {
    const content = getToolResultContent(events, use.id!);
    const match = content.match(/exit=(\d+)/);
    if (match && parseInt(match[1], 10) === expectedCode) {
      return pass(`Bash exit code ${expectedCode} found`);
    }
  }
  // Check the last bash call specifically
  if (bashUses.length > 0) {
    const last = bashUses[bashUses.length - 1];
    const content = getToolResultContent(events, last.id!);
    const match = content.match(/exit=(\d+)/);
    const actual = match ? match[1] : "unknown";
    return fail(`Expected bash exit=${expectedCode}, last bash got exit=${actual}`, [
      `Output preview: ${content.slice(0, 300)}`,
    ]);
  }
  return fail("No bash tool calls found");
}

/** Assert the last bash call exited with 0 */
export function assertLastBashSuccess(events: SSEEvent[]): VerifyResult {
  const bashUses = toolUseEvents(events).filter((e) => e.name === "bash");
  if (bashUses.length === 0) return fail("No bash tool calls found");
  const last = bashUses[bashUses.length - 1];
  const content = getToolResultContent(events, last.id!);
  const match = content.match(/exit=(\d+)/);
  if (match && match[1] === "0") return pass("Last bash exited with 0");
  // Also check if the content doesn't contain error patterns and no exit code shown (some formats)
  if (!match && !content.toLowerCase().includes("error") && !content.toLowerCase().includes("traceback")) {
    return pass("Last bash completed without errors");
  }
  return fail(`Last bash did not exit cleanly`, [`Output: ${content.slice(0, 500)}`]);
}

/** Assert session reached idle without session.error */
export function assertIdleNoError(events: SSEEvent[]): VerifyResult {
  const errors = eventsOfType(events, "session.error");
  if (errors.length > 0) {
    return fail("Session had errors", errors.map((e) => `Error: ${JSON.stringify(e)}`));
  }
  const idle = eventsOfType(events, "session.status_idle");
  if (idle.length === 0) {
    return fail("Session never reached idle status");
  }
  return pass("Session reached idle without errors");
}

/** Assert tools were used in a specific order (allows other tools in between) */
export function assertToolOrder(events: SSEEvent[], toolNames: string[]): VerifyResult {
  const uses = toolUseEvents(events).map((e) => e.name);
  let idx = 0;
  for (const use of uses) {
    if (idx < toolNames.length && use === toolNames[idx]) {
      idx++;
    }
  }
  if (idx === toolNames.length) {
    return pass(`Tools used in order: ${toolNames.join(" → ")}`);
  }
  return fail(
    `Expected tool order [${toolNames.join(", ")}], but only matched up to index ${idx}`,
    [`Actual tool sequence: ${uses.join(", ")}`],
  );
}

/** Assert at least N tool calls total */
export function assertMinToolCalls(events: SSEEvent[], min: number): VerifyResult {
  const count = toolUseEvents(events).length;
  return count >= min
    ? pass(`${count} tool calls (>= ${min})`)
    : fail(`Only ${count} tool calls, expected at least ${min}`);
}

/** Assert agent message contains substring */
export function assertAgentMessageContains(events: SSEEvent[], substring: string): VerifyResult {
  const messages = eventsOfType(events, "agent.message");
  for (const msg of messages) {
    if (getMessageText(msg).includes(substring)) {
      return pass(`Agent message contains "${substring}"`);
    }
  }
  return fail(`No agent message contains "${substring}"`);
}

/** Assert a file was written (tool "write" used with matching path) */
export function assertFileWritten(events: SSEEvent[], path: string): VerifyResult {
  const writes = toolUseEvents(events).filter(
    (e) => e.name === "write" && (e.input as any)?.file_path === path,
  );
  return writes.length > 0
    ? pass(`File "${path}" was written`)
    : fail(`File "${path}" was never written`);
}

/** Combine multiple verification results — passes only if ALL pass */
export function allOf(...results: VerifyResult[]): VerifyResult {
  const failures = results.filter((r) => r.status === "fail");
  if (failures.length === 0) {
    return pass("All checks passed");
  }
  return fail(
    `${failures.length}/${results.length} checks failed`,
    failures.map((f) => `FAIL: ${f.message}`),
  );
}

/** Combine multiple verification results — passes if ANY passes */
export function anyOf(...results: VerifyResult[]): VerifyResult {
  const passes = results.filter((r) => r.status === "pass");
  if (passes.length > 0) {
    return pass(passes[0].message);
  }
  return fail(
    "All checks failed",
    results.map((r) => `FAIL: ${r.message}`),
  );
}
