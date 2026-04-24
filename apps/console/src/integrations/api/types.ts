// DTO shapes returned by apps/main /v1/integrations/* endpoints. Keep
// snake_case to match the wire format — JS clients can still read them
// without ceremony.

// ─── Linear ────────────────────────────────────────────────────────────

export interface LinearInstallation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  install_kind: "dedicated";
  bot_user_id: string;
  vault_id: string | null;
  created_at: number;
}

export interface LinearPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  status: "pending_setup" | "awaiting_install" | "live" | "needs_reauth" | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  session_granularity: "per_issue" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

// ─── Slack ─────────────────────────────────────────────────────────────

export interface SlackInstallation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  install_kind: "dedicated";
  bot_user_id: string;
  vault_id: string | null;
  created_at: number;
}

export interface SlackPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  status: "pending_setup" | "awaiting_install" | "live" | "needs_reauth" | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  /** Slack defaults to per_thread; per_event also supported. */
  session_granularity: "per_thread" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

// ─── Shared install-flow shapes ─────────────────────────────────────────

/** First step result — handed to the user as a credentials form. */
export interface A1FormStep {
  formToken: string;
  suggestedAppName: string;
  suggestedAvatarUrl: string | null;
  callbackUrl: string;
  /** OAuth Redirect URL for Linear; Events Request URL for Slack. */
  webhookUrl: string;
  /**
   * Slack-only: pre-filled "Create from manifest" URL the user can open to
   * have Slack auto-configure the App with all scopes/events/redirect URLs.
   * Linear's analogous flow is built into linear.app and needs no URL.
   */
  manifestLaunchUrl?: string | null;
}

export interface A1InstallLink {
  /** OAuth URL the user clicks to authorize the install. */
  url: string;
  appId: string;
  callbackUrl: string;
  webhookUrl: string;
}

export interface HandoffLink {
  url: string;
  expiresInDays: number;
}

export interface PublishWizardInput {
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl?: string | null;
  /** Where to redirect when install completes. */
  returnUrl: string;
}

// ─── Slack-specific input narrows ──────────────────────────────────────

export interface SlackSubmitCredentialsInput {
  formToken: string;
  clientId: string;
  clientSecret: string;
  /** Slack's per-App Signing Secret (from App admin → Basic Information). */
  signingSecret: string;
}

export interface LinearSubmitCredentialsInput {
  formToken: string;
  clientId: string;
  clientSecret: string;
  /** Linear's webhook signing secret (lin_wh_…). */
  webhookSecret: string;
}

// ─── GitHub ────────────────────────────────────────────────────────────

export interface GitHubInstallation {
  id: string;
  /** Numeric GitHub installation_id (string-typed). */
  workspace_id: string;
  /** Org or user login (e.g. "acme"). */
  workspace_name: string;
  install_kind: "dedicated";
  /** Bot login the App acts as (e.g. "myapp[bot]"). */
  bot_login: string;
  vault_id: string | null;
  created_at: number;
}

export interface GitHubPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  status: "pending_setup" | "awaiting_install" | "live" | "needs_reauth" | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  session_granularity: "per_issue" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

export interface GitHubA1FormStep {
  formToken: string;
  appOmaId: string;
  suggestedAppName: string;
  suggestedAvatarUrl: string | null;
  setupUrl: string;
  webhookUrl: string;
  /** Recommended UX path: opens a manifest auto-POST page on the gateway
   *  that streamlines App registration to ~30s. Optional because not every
   *  step variant exposes it (e.g. server-side resumed flows). */
  manifestStartUrl?: string;
  recommendedPermissions: Record<string, string>;
  recommendedSubscriptions: string[];
}

export interface GitHubA1InstallLink {
  url: string;
  appOmaId: string;
  appSlug: string;
  botLogin: string;
  setupUrl: string;
  webhookUrl: string;
}

// ─── Sessions (subset, used by activity timeline) ────────────────────────
//
// Mirrors a slice of @open-managed-agents/shared SessionMeta. Kept inline
// here so the console UI stays decoupled from the host server's type
// package — snake-case shapes match the wire format.

export interface SessionSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
  /**
   * Free-form metadata stamped at session create time. The github provider
   * writes `{ github: { installationId, repository, eventKind, ... } }`;
   * the linear provider writes its own shape. Activity-feed consumers
   * narrow this themselves rather than us pretending one shape fits all.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Fields the github provider stamps onto session.metadata.github at create
 * time. See packages/github/src/provider.ts. Optional because the same
 * SessionSummary type is reused for non-github sessions.
 */
export interface GitHubSessionMetadata {
  installationId?: string;
  repository?: string;
  itemKind?: "issue" | "pull_request" | null;
  itemNumber?: number | null;
  commentId?: number | null;
  actorLogin?: string | null;
  eventKind?: string | null;
  eventType?: string;
  deliveryId?: string;
  htmlUrl?: string | null;
  /** Set on per_issue sessions for resume keying. */
  issueKey?: string;
}
