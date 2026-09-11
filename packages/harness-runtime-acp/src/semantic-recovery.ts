import type { ManagedHarnessSemanticRecoveryPort } from "./index.js";
import type { ManagedHarnessRecoveryReason } from "./index.js";

export type ManagedRecoveryContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image" | "document";
      source: { file_id?: string; url?: string };
      title?: string;
    };

type Extensible<T> = T & { [key: string]: unknown };

export type ManagedRecoveryEvent =
  | Extensible<{ type: "user.message" | "agent.message"; content: ManagedRecoveryContentBlock[] }>
  | Extensible<{
      type: "agent.thread_context_compacted";
      summary?: ManagedRecoveryContentBlock[];
    }>
  | Extensible<{ type: "agent.tool_use" | "agent.custom_tool_use"; id: string; name: string }>
  | Extensible<{ type: "agent.mcp_tool_use"; id: string; name: string; mcp_server_name: string }>
  | Extensible<{
      type: "agent.tool_result";
      tool_use_id: string;
      content: string | ManagedRecoveryContentBlock[];
    }>
  | Extensible<{
      type: "agent.mcp_tool_result";
      mcp_tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>
  | Extensible<{
      type: "user.custom_tool_result";
      custom_tool_use_id: string;
      content: ManagedRecoveryContentBlock[];
    }>;

export interface ManagedHarnessRecoveryHistoryPort {
  list(sessionId: string): Promise<readonly ManagedRecoveryEvent[]>;
}

export interface ManagedEventSemanticRecoveryOptions {
  history: ManagedHarnessRecoveryHistoryPort;
  maxCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 32_000;

/** Builds a bounded, side-effect-safe ACP recovery turn from canonical
 * Managed Events. Native agent formats are intentionally never synthesized. */
export function createManagedEventSemanticRecovery(
  options: ManagedEventSemanticRecoveryOptions,
): ManagedHarnessSemanticRecoveryPort {
  return {
    async build(input) {
      return buildManagedEventRecoveryPrompt(
        await options.history.list(input.sessionId),
        input.currentPrompt,
        {
          reason: input.reason,
          maxCharacters: options.maxCharacters,
        },
      );
    },
  };
}

export function buildManagedEventRecoveryPrompt(
  events: readonly ManagedRecoveryEvent[],
  currentPrompt: string,
  options: {
    reason: ManagedHarnessRecoveryReason;
    maxCharacters?: number;
  },
): string {
  const relevantEvents = withoutCurrentPrompt(
    eventsAfterLastCompaction(events),
    currentPrompt,
  );
  const toolNames = collectToolNames(relevantEvents);
  const lines = relevantEvents.flatMap((event) =>
    eventToRecoveryLines(event, toolNames)
  );
  const prefix = [
    `<openma-recovery version="1" reason="${options.reason}">`,
    options.reason === "native-state-stale"
      ? "The previous agent-native session state does not cover the latest canonical completed turn."
      : "The previous agent-native session state is unavailable.",
    "Continue from the canonical OpenMA history and the current workspace.",
    "Do not repeat completed side effects. Inspect current files before changing them.",
    "Recovered conversation:",
  ].join("\n");
  const maxCharacters = Math.max(
    1_024,
    options.maxCharacters ?? DEFAULT_MAX_CHARACTERS,
  );
  const currentLabel = "Current request:";
  const closingTag = "</openma-recovery>";
  const payloadBudget = Math.max(
    0,
    maxCharacters - prefix.length - currentLabel.length - closingTag.length - 4,
  );
  const currentBudget = lines.length > 0
    ? Math.max(256, Math.floor(payloadBudget * 0.6))
    : payloadBudget;
  const boundedCurrent = truncateCurrentRequest(currentPrompt.trim(), currentBudget);
  const history = takeRecentLines(
    lines,
    Math.max(0, payloadBudget - boundedCurrent.length),
  );
  return [prefix, history, currentLabel, boundedCurrent, closingTag].join("\n");
}

function eventsAfterLastCompaction(
  events: readonly ManagedRecoveryEvent[],
): ManagedRecoveryEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "agent.thread_context_compacted") continue;
    const summary = contentToText(event.summary ?? []).trim();
    if (!summary) continue;
    return [
      {
        type: "user.message",
        content: [{
          type: "text",
          text: `<conversation-summary>\n${summary}\n</conversation-summary>`,
        }],
      },
      ...events.slice(index + 1),
    ];
  }
  return [...events];
}

function withoutCurrentPrompt(
  events: readonly ManagedRecoveryEvent[],
  currentPrompt: string,
): ManagedRecoveryEvent[] {
  let currentIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.type === "user.message"
      && contentToText(event.content).trim() === currentPrompt.trim()
    ) {
      currentIndex = index;
      break;
    }
  }
  return currentIndex < 0
    ? [...events]
    : events.filter((_, index) => index !== currentIndex);
}

function collectToolNames(events: readonly ManagedRecoveryEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === "agent.tool_use" || event.type === "agent.custom_tool_use") {
      names.set(event.id, event.name);
    } else if (event.type === "agent.mcp_tool_use") {
      names.set(event.id, `${event.mcp_server_name}/${event.name}`);
    }
  }
  return names;
}

function eventToRecoveryLines(
  event: ManagedRecoveryEvent,
  toolNames: ReadonlyMap<string, string>,
): string[] {
  switch (event.type) {
    case "user.message": {
      const text = contentToText(event.content).trim();
      return text ? [`User: ${text}`] : [];
    }
    case "agent.message": {
      const text = contentToText(event.content).trim();
      return text ? [`Assistant: ${text}`] : [];
    }
    case "agent.tool_result": {
      const result = typeof event.content === "string"
        ? event.content
        : contentToText(event.content);
      return result.trim()
        ? [`Completed tool ${toolNames.get(event.tool_use_id) ?? "unknown"}: ${result.trim()}`]
        : [];
    }
    case "agent.mcp_tool_result":
      return event.content.trim()
        ? [
            `${event.is_error ? "Failed" : "Completed"} tool ${
              toolNames.get(event.mcp_tool_use_id) ?? "unknown"
            }: ${event.content.trim()}`,
          ]
        : [];
    case "user.custom_tool_result": {
      const result = contentToText(event.content).trim();
      return result
        ? [`Completed tool ${toolNames.get(event.custom_tool_use_id) ?? "unknown"}: ${result}`]
        : [];
    }
    default:
      return [];
  }
}

function contentToText(content: readonly ManagedRecoveryContentBlock[]): string {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    const reference = block.source.file_id ?? block.source.url;
    const label = block.type === "document" && block.title
      ? `${block.type} ${block.title}`
      : block.type;
    return reference ? `[${label}: ${reference}]` : `[${label}]`;
  }).filter(Boolean).join("\n");
}

function takeRecentLines(lines: readonly string[], budget: number): string {
  const selected: string[] = [];
  let remaining = budget;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + (selected.length > 0 ? 1 : 0);
    if (cost <= remaining) {
      selected.unshift(line);
      remaining -= cost;
      continue;
    }
    // The public builder enforces a 1 KiB envelope and reserves at most 60%
    // for the current request, so a non-empty history always has room for an
    // ellipsis plus at least one character here.
    if (selected.length === 0) {
      selected.unshift(`…${line.slice(Math.max(0, line.length - remaining + 1))}`);
    }
    break;
  }
  const omitted = "… earlier history omitted …";
  if (selected.length < lines.length) {
    while (
      selected.length > 0
      && selected.join("\n").length + omitted.length + 1 > budget
    ) selected.shift();
    selected.unshift(omitted);
  }
  return selected.join("\n");
}

function truncateCurrentRequest(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker = "\n… [current request truncated] …\n";
  const remaining = Math.max(0, budget - marker.length);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
