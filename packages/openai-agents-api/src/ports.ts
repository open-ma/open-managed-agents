// Protocol-facing adapter contract. Implementations bridge to the existing
// application ports without making the application core depend on OpenAI types.
export type Metadata = Record<string, string>;
export type ServiceTier = "auto" | "default" | "flex" | "priority" | "fast";
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface Reasoning { effort: Effort | null; summary: "concise" | "detailed" | "auto" | null }
export interface FunctionTool { type: "function"; name: string; description: string; parameters: Record<string, unknown>; deferLoading: boolean }
export interface AgentConfiguration {
  model?: string;
  instructions?: string | null;
  reasoning?: Partial<Reasoning> | null;
  serviceTier?: ServiceTier | null;
  multiAgent?: { enabled: boolean; maxConcurrentSubagents?: number } | null;
  text?: { verbosity?: "low" | "medium" | "high" | null; format?: { type: "text" } | null } | null;
  tools?: Array<Omit<FunctionTool, "deferLoading"> & { deferLoading?: boolean }> | null;
}
export type EnvironmentConfiguration =
  | { type: "none" }
  | { type: "selfHosted"; workspaceDirectory: string; capabilityDirectories?: string[] | null }
  | { type: "hosted"; templateId?: string; env?: Metadata | null; capabilityDirectories?: string[] | null; packages?: { npm?: string[] | null; python?: string[] | null; system?: string[] | null } | null; network?: { access: "enabled" | "disabled" | "restricted"; allowedDomains?: string[] | null } | null };
export type InputContent = { type: "text"; text: string } | { type: "image"; imageUrl: string };
export interface InputMessage { role: "user"; content: InputContent[] }
export interface CreateSessionCommand {
  environment: EnvironmentConfiguration;
  agent?: AgentConfiguration;
  agentId?: string;
  input?: string | InputMessage[] | null;
  metadata?: Metadata | null;
  vaultIds?: string[] | null;
}
export interface ListQuery { after?: string; limit?: number; order?: "asc" | "desc" }
export interface ListSessionsQuery extends ListQuery { agentId?: string }
export interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens: number; inputTokensDetails: { cachedTokens: number }; outputTokensDetails: { reasoningTokens: number } }
export type EnvironmentView =
  | { type: "none" }
  | { type: "selfHosted"; id: string; workspaceDirectory: string; capabilityDirectories: string[]; remoteUrl: string };
export interface SessionView {
  id: string;
  agent: { id: string; name: string | null; model: string; instructions: string | null; reasoning: Reasoning; serviceTier: ServiceTier; multiAgent: { enabled: boolean; maxConcurrentSubagents: number | null }; text: { verbosity: "low" | "medium" | "high"; format: { type: "text" } }; tools: FunctionTool[] };
  createdAt: number;
  lastActiveAt: number;
  environment: EnvironmentView;
  error: string | null;
  metadata: Metadata;
  requiredActions: Array<{ type: "functionCall"; callId: string; turnId: string; name: string; arguments: unknown } | { type: "environmentConnection"; environmentId: string }>;
  status: "idle" | "inProgress" | "requiresAction" | "failed";
  usage: TokenUsage | null;
  vaultIds: string[];
}
export interface TurnView {
  id: string; agentId: string; sessionId: string; subagentId: string | null;
  createdAt: number; startedAt: number | null; completedAt: number | null;
  status: "queued" | "inProgress" | "waiting" | "completed" | "failed" | "cancelled";
  error: { code: string; message: string } | null; usage: TokenUsage | null;
}
export interface MessageItemView {
  type: "message"; id: string | null; turnId: string; role: "user" | "assistant";
  content: Array<InputContent | { type: "outputText"; text: string }>;
  phase: "commentary" | "finalAnswer" | null; status: "inProgress" | "completed" | "incomplete";
}
export type SessionInput =
  | { type: "message"; input: InputMessage[] }
  | { type: "cancel" }
  | { type: "toolResult"; callId: string; turnId: string; success: boolean; error?: string | null; output?: string | InputContent[] | null };
export type SessionEvent =
  | { type: "created" | "idle" | "inProgress" | "requiresAction" | "failed"; eventId: string; session: SessionView }
  | { type: "outputTextDelta"; eventId: string; sessionId: string; turnId: string | null; itemId: string; contentIndex: number; outputIndex: number; delta: string }
  | { type: "outputTextDone"; eventId: string; sessionId: string; turnId: string | null; itemId: string; contentIndex: number; outputIndex: number; text: string }
  | { type: "turnCreated" | "turnInProgress"; eventId: string; sessionId: string; turnId: string; turn: TurnView }
  | { type: "turnCompleted" | "turnFailed" | "turnCancelled"; eventId: string; sessionId: string; turnId: string; turn: TurnView; usage: TokenUsage | null };
export type ApplicationError = { type: "invalidRequest" | "notFound" | "conflict" | "unsupported"; message: string; param?: string };
export type Result<T> = { type: "success"; value: T } | ApplicationError;
export interface Page<T> { data: T[]; hasMore: boolean }
export interface SessionsApplicationPort {
  createSession(command: CreateSessionCommand): Promise<Result<SessionView>>;
  retrieveSession(query: { sessionId: string }): Promise<Result<SessionView>>;
  updateSession(command: { sessionId: string; metadata?: Metadata | null }): Promise<Result<SessionView>>;
  listSessions(query: ListSessionsQuery): Promise<Result<Page<SessionView>>>;
  deleteSession(command: { sessionId: string }): Promise<Result<{ sessionId: string }>>;
  /** signal closes the event subscription only; it must not cancel durable work. */
  createSessionStream?(command: CreateSessionCommand, signal: AbortSignal): Promise<Result<AsyncIterable<SessionEvent>>>;
  sendEvents?(command: { sessionId: string; events: SessionInput[]; idempotencyKey?: string }): Promise<Result<void>>;
  /** Turn cancellation is an explicit input event, never a stream disconnect. */
  streamEvents?(query: { sessionId: string }, signal: AbortSignal): Promise<Result<AsyncIterable<SessionEvent>>>;
  listItems?(query: ListQuery & { sessionId: string }): Promise<Result<Page<MessageItemView>>>;
  listTurns?(query: ListQuery & { sessionId: string }): Promise<Result<Page<TurnView>>>;
  retrieveTurn?(query: { sessionId: string; turnId: string }): Promise<Result<TurnView>>;
}
