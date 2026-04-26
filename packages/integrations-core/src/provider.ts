// IntegrationProvider — the contract every external integration implements.
//
// One provider per external system (Linear, Slack, GitHub). The gateway
// (apps/integrations) routes provider-prefixed URLs to the matching provider
// and exposes the provider's MCP tools at session time.

import type {
  CapabilitySet,
  Persona,
  ProviderId,
  Publication,
  PublicationMode,
  SessionGranularity,
  UserId,
  AgentId,
} from "./domain";

/**
 * Scope of a single MCP tool call from an agent session. Embedded in the JWT
 * the gateway hands to the agent; the provider validates calls fall within it.
 */
export interface McpScope {
  publicationId: string;
  installationId: string;
  /** Provider-native issue id this session is about (per_issue mode). */
  issueId: string | null;
  /** OMA session id. */
  sessionId: string;
  capabilities: CapabilitySet;
  /** Unix seconds. */
  expiresAt: number;
}

/** JSON-Schema-shaped tool descriptor delivered to the agent at session start. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Result of one MCP tool call. */
export type McpToolResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } };

// ─── Install flow types ────────────────────────────────────────────────

/** Hint for which install flow to run. */
export interface StartInstallInput {
  userId: UserId;
  agentId: AgentId;
  /** OMA environment the agent will use when triggered. */
  environmentId: string;
  mode: PublicationMode;
  /** UI-supplied persona; provider may override (e.g. A1 forces App name). */
  persona: Persona;
  /** Where to redirect when install completes. */
  returnUrl: string;
}

/** Continuation payload — opaque body the user posts back to finish install. */
export interface ContinueInstallInput {
  /**
   * Set when a publication exists already (A1 wizard). Null for B+ where the
   * publication is created atomically with the installation in the OAuth
   * callback.
   */
  publicationId: string | null;
  /** Free-form continuation data: OAuth code, App credentials, etc. */
  payload: Record<string, unknown>;
}

/** Provider asks the gateway to render a follow-up step to the user. */
export interface InstallStep {
  kind: "step";
  step: "redirect" | "credentials_form" | "install_link" | "wait_for_webhook";
  data: Record<string, unknown>;
}

/** Provider signals install completion. */
export interface InstallComplete {
  kind: "complete";
  publicationId: string;
}

// ─── Webhook types ─────────────────────────────────────────────────────

export interface WebhookRequest {
  /** Path-derived: which provider entry handled this request. */
  providerId: ProviderId;
  /** Path-derived: shared install or per-app install id. */
  installationId: string | null;
  /** Always present from Linear; null in tests. */
  deliveryId: string | null;
  /** Headers Linear sends (lowercased keys). */
  headers: Record<string, string>;
  /** Raw body for HMAC verification. */
  rawBody: string;
}

export interface WebhookOutcome {
  /** Whether the event resulted in a session create/resume. */
  handled: boolean;
  /** Why we ignored it (e.g. unknown event type, dedup, no route match). */
  reason?: string;
  publicationId?: string;
  sessionId?: string;
  /** The tenant the (verified) webhook belongs to. Set once signature
   *  verification + installation lookup have succeeded. The route handler
   *  uses this to apply per-tenant rate limits before triggering the
   *  expensive deferredWork — without leaking tenant lookup logic into
   *  the route layer. Absent on sig-fail / unknown-app outcomes. */
  tenantId?: string;
  /**
   * Optional plain-text body the route handler should echo back in the 200
   * response. Used by Slack's `url_verification` handshake — the gateway must
   * return Slack's challenge string within 3 sec.
   */
  challengeResponse?: string;
  /**
   * Optional async work the route handler should attach to
   * `c.executionCtx.waitUntil(...)` so the webhook can 200 immediately.
   * Slack's 3-second response budget rules out doing the dispatch inline; the
   * provider returns the dispatch closure here and lets the route detach it.
   */
  deferredWork?: () => Promise<void>;
}

// ─── Provider interface ────────────────────────────────────────────────

export interface IntegrationProvider {
  readonly id: ProviderId;

  startInstall(input: StartInstallInput): Promise<InstallStep | InstallComplete>;
  continueInstall(input: ContinueInstallInput): Promise<InstallStep | InstallComplete>;
  handleWebhook(req: WebhookRequest): Promise<WebhookOutcome>;

  /** Tool descriptors visible to the agent at session start. */
  mcpTools(scope: McpScope): Promise<ReadonlyArray<McpToolDescriptor>>;
  /** Run a tool. Capability checks happen inside; failures returned, not thrown. */
  invokeMcpTool(scope: McpScope, toolName: string, input: unknown): Promise<McpToolResult>;
}

// ─── Re-exports for convenience ────────────────────────────────────────

export type { Publication, Persona, SessionGranularity };
