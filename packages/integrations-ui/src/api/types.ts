// DTO shapes returned by apps/main /v1/integrations/* endpoints. Keep
// snake_case to match the wire format — JS clients can still read them
// without ceremony.

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

export interface A1FormStep {
  formToken: string;
  suggestedAppName: string;
  suggestedAvatarUrl: string | null;
  callbackUrl: string;
  webhookUrl: string;
}

export interface A1InstallLink {
  /** Linear OAuth URL the user clicks to install the App. */
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
