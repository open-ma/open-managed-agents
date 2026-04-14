import type { ModelMessage, LanguageModel } from "ai";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

export interface HarnessInterface {
  run(ctx: HarnessContext): Promise<void>;
}

export interface HarnessContext {
  agent: AgentConfig;
  userMessage: UserMessageEvent;

  /** Platform-prepared tools: built from agent config, ready to pass to generateText. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;

  /** Platform-prepared model: resolved from agent config with API key. */
  model: LanguageModel;

  /** System prompt: base from agent.system + skill metadata additions. */
  systemPrompt: string;

  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    CONFIG_KV?: KVNamespace;
    memoryStoreIds?: string[];
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
    /** Register a background task for completion notification (CC-style task_notification). */
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
  };
  runtime: {
    history: HistoryStore;
    sandbox: SandboxExecutor;
    broadcast: (event: SessionEvent) => void;
    reportUsage?: (input_tokens: number, output_tokens: number) => Promise<void>;
    pendingConfirmations?: string[];
    abortSignal?: AbortSignal;
  };
}

export interface HistoryStore {
  getMessages(): ModelMessage[];
  append(event: SessionEvent): void;
  getEvents(afterSeq?: number): SessionEvent[];
}

export interface ProcessHandle {
  id: string;
  pid: number;
  kill(signal: string): Promise<void>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  getStatus(): Promise<string>;
}

export interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  /** Start a process without blocking. Returns handle for kill/status/logs. */
  startProcess?(command: string): Promise<ProcessHandle | null>;
  /** Set global environment variables for all subsequent exec calls. */
  setEnvVars?(envVars: Record<string, string>): Promise<void>;
  /** Native git checkout (if supported by sandbox). */
  gitCheckout?(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown>;
  /** Register secrets injected only for commands matching a prefix (e.g. "git", "gh"). */
  registerCommandSecrets?(commandPrefix: string, secrets: Record<string, string>): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  /** Destroy the sandbox container — kills processes, unmounts, stops. */
  destroy?(): Promise<void>;
}
