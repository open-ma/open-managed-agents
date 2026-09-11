import type {
  ContentBlock,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";

export type AcpSemanticRecoveryReason = "native-state-missing";

export interface AcpSemanticRecoveryOptions {
  reason: AcpSemanticRecoveryReason;
  maxCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 32_000;

/**
 * Project the canonical Managed Agents event log into one ACP user turn.
 *
 * This is deliberately semantic rather than a native-format conversion:
 * completed tool inputs are never copied into the prompt, so restoring a
 * missing private session cannot accidentally replay an old side effect.
 */
export function buildAcpSemanticRecoveryPrompt(
  events: readonly SessionEvent[],
  currentMessage: UserMessageEvent,
  options: AcpSemanticRecoveryOptions,
): string {
  const currentText = contentToText(currentMessage.content).trim();
  const relevantEvents = withoutCurrentMessage(
    eventsAfterLastCompaction(events),
    currentMessage,
  );
  const toolNames = collectToolNames(relevantEvents);
  const lines = relevantEvents.flatMap((event) =>
    eventToRecoveryLines(event, toolNames)
  );

  const prefix = [
    `<openma-recovery version="1" reason="${options.reason}">`,
    "The previous agent-native session state is unavailable.",
    "Continue from the canonical OpenMA history and the current workspace.",
    "Do not repeat completed side effects. Inspect current files before changing them.",
    "Recovered conversation:",
  ].join("\n");
  const maxCharacters = Math.max(1_024, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
  const currentLabel = "Current request:";
  const closingTag = "</openma-recovery>";
  // Four separators join prefix/history/current-label/current/closing-tag.
  const payloadBudget = Math.max(
    0,
    maxCharacters - prefix.length - currentLabel.length - closingTag.length - 4,
  );
  const currentBudget = lines.length > 0
    ? Math.max(256, Math.floor(payloadBudget * 0.6))
    : payloadBudget;
  const boundedCurrent = truncateCurrentRequest(currentText, currentBudget);
  const historyBudget = Math.max(0, payloadBudget - boundedCurrent.length);
  const history = takeRecentLines(lines, historyBudget);
  return [
    prefix,
    history,
    currentLabel,
    boundedCurrent,
    closingTag,
  ].join("\n");
}

function eventsAfterLastCompaction(
  events: readonly SessionEvent[],
): SessionEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
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

function withoutCurrentMessage(
  events: readonly SessionEvent[],
  currentMessage: UserMessageEvent,
): SessionEvent[] {
  // SessionDO normally persists the current event before entering the
  // harness. Match by object identity or durable event id, never by text: two
  // consecutive user turns are allowed to contain exactly the same bytes.
  let currentIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event === currentMessage ||
      (currentMessage.id !== undefined &&
        event.type === "user.message" &&
        event.id === currentMessage.id)
    ) {
      currentIndex = index;
      break;
    }
  }
  return currentIndex < 0
    ? [...events]
    : events.filter((_, index) => index !== currentIndex);
}

function collectToolNames(events: readonly SessionEvent[]): Map<string, string> {
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
  event: SessionEvent,
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

function contentToText(content: readonly ContentBlock[]): string {
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
    const line = lines[index];
    const cost = line.length + (selected.length > 0 ? 1 : 0);
    if (cost <= remaining) {
      selected.unshift(line);
      remaining -= cost;
      continue;
    }
    if (selected.length === 0) {
      selected.unshift(`…${line.slice(Math.max(0, line.length - remaining + 1))}`);
    }
    break;
  }
  const omitted = "… earlier history omitted …";
  if (selected.length < lines.length && omitted.length <= budget) {
    while (
      selected.length > 0 &&
      selected.join("\n").length + omitted.length + 1 > budget
    ) {
      selected.shift();
    }
    selected.unshift(omitted);
  }
  return selected.join("\n");
}

function truncateCurrentRequest(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker = "\n… [current request truncated] …\n";
  const remaining = budget - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
