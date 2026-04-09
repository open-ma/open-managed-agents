import type { CoreMessage } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "../types";

export interface HarnessInterface {
  run(ctx: HarnessContext): Promise<void>;
}

export interface HarnessContext {
  agent: AgentConfig;
  userMessage: UserMessageEvent;
  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    CONFIG_KV?: KVNamespace;
    memoryStoreIds?: string[];
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
  };
  runtime: {
    history: HistoryStore;
    sandbox: SandboxExecutor;
    broadcast: (event: SessionEvent) => void;
    reportUsage?: (input_tokens: number, output_tokens: number) => Promise<void>;
    pendingConfirmations?: string[];
  };
}

export interface HistoryStore {
  getMessages(): CoreMessage[];
  append(event: SessionEvent): void;
  getEvents(afterSeq?: number): SessionEvent[];
}

export interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
}
