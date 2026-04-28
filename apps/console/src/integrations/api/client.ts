// Typed wrapper around fetch for /v1/integrations/* endpoints.
//
// Credentials are sent via session cookie (better-auth). The base path is
// configurable for tests; defaults to the Console's same-origin "".
//
// Each integration provider gets a sub-client (api.linear.*, api.slack.*,
// api.github.*) with the same method shapes. Provider-specific quirks
// (e.g. signingSecret vs webhookSecret) live in narrow input types.

import type {
  A1FormStep,
  A1InstallLink,
  GitHubA1FormStep,
  GitHubA1InstallLink,
  GitHubInstallation,
  GitHubPublication,
  HandoffLink,
  LinearInstallation,
  LinearPublication,
  LinearSubmitCredentialsInput,
  PublishWizardInput,
  SessionSummary,
  SlackInstallation,
  SlackPublication,
  SlackSubmitCredentialsInput,
} from "./types";

export interface IntegrationsApiOptions {
  basePath?: string;
}

async function request<T = unknown>(
  basePath: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${basePath}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: string };
    throw new Error(body.details || body.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// ─── Linear sub-client ─────────────────────────────────────────────────

class LinearClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<LinearInstallation[]> {
    const r = await request<{ data: LinearInstallation[] }>(
      this.basePath,
      "/v1/integrations/linear/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<LinearPublication[]> {
    const r = await request<{ data: LinearPublication[] }>(
      this.basePath,
      `/v1/integrations/linear/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async listAgentPublications(agentId: string): Promise<LinearPublication[]> {
    const r = await request<{ data: LinearPublication[] }>(
      this.basePath,
      `/v1/integrations/linear/agents/${encodeURIComponent(agentId)}/publications`,
    );
    return r.data;
  }

  async getPublication(id: string): Promise<LinearPublication> {
    return request<LinearPublication>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<LinearPublication> {
    return request<LinearPublication>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return request<A1FormStep>(this.basePath, "/v1/integrations/linear/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: LinearSubmitCredentialsInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/linear/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/linear/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }
}

// ─── GitHub sub-client ─────────────────────────────────────────────────

class GitHubClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<GitHubInstallation[]> {
    const r = await request<{ data: GitHubInstallation[] }>(
      this.basePath,
      "/v1/integrations/github/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<GitHubPublication[]> {
    const r = await request<{ data: GitHubPublication[] }>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async getPublication(id: string): Promise<GitHubPublication> {
    return request<GitHubPublication>(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<GitHubPublication> {
    return request<GitHubPublication>(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  // ─── Install initiation (proxied through main → integrations gateway) ───

  async startA1(input: PublishWizardInput): Promise<GitHubA1FormStep> {
    return request<GitHubA1FormStep>(this.basePath, "/v1/integrations/github/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: {
    formToken: string;
    appId: string;
    privateKey: string;
    webhookSecret: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<GitHubA1InstallLink> {
    return request<GitHubA1InstallLink>(this.basePath, "/v1/integrations/github/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/github/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }
}

// ─── Slack sub-client ──────────────────────────────────────────────────

class SlackClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<SlackInstallation[]> {
    const r = await request<{ data: SlackInstallation[] }>(
      this.basePath,
      "/v1/integrations/slack/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<SlackPublication[]> {
    const r = await request<{ data: SlackPublication[] }>(
      this.basePath,
      `/v1/integrations/slack/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async listAgentPublications(agentId: string): Promise<SlackPublication[]> {
    const r = await request<{ data: SlackPublication[] }>(
      this.basePath,
      `/v1/integrations/slack/agents/${encodeURIComponent(agentId)}/publications`,
    );
    return r.data;
  }

  async getPublication(id: string): Promise<SlackPublication> {
    return request<SlackPublication>(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<SlackPublication> {
    return request<SlackPublication>(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return request<A1FormStep>(this.basePath, "/v1/integrations/slack/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: SlackSubmitCredentialsInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/slack/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/slack/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }
}

// ─── Public surface ────────────────────────────────────────────────────

export class IntegrationsApi {
  private readonly basePath: string;
  readonly linear: LinearClient;
  readonly slack: SlackClient;
  readonly github: GitHubClient;

  constructor(opts: IntegrationsApiOptions = {}) {
    const basePath = opts.basePath ?? "";
    this.basePath = basePath;
    this.linear = new LinearClient(basePath);
    this.slack = new SlackClient(basePath);
    this.github = new GitHubClient(basePath);
  }

  // ─── Linear backward-compat shims ─────────────────────────────────────
  // Existing Linear pages call `api.listInstallations()` directly. Keep these
  // delegating to `linear.*` so the page diffs stay zero. New code should
  // prefer `api.linear.*` or `api.slack.*`.

  listInstallations(): Promise<LinearInstallation[]> {
    return this.linear.listInstallations();
  }
  listPublications(installationId: string): Promise<LinearPublication[]> {
    return this.linear.listPublications(installationId);
  }
  getPublication(id: string): Promise<LinearPublication> {
    return this.linear.getPublication(id);
  }
  updatePublication(
    id: string,
    patch: { persona?: Partial<{ name: string; avatarUrl: string | null }>; capabilities?: string[] },
  ): Promise<LinearPublication> {
    return this.linear.updatePublication(id, patch);
  }
  unpublish(id: string): Promise<void> {
    return this.linear.unpublish(id);
  }
  startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return this.linear.startA1(input);
  }
  submitCredentials(input: LinearSubmitCredentialsInput): Promise<A1InstallLink> {
    return this.linear.submitCredentials(input);
  }
  createHandoffLink(formToken: string): Promise<HandoffLink> {
    return this.linear.createHandoffLink(formToken);
  }

  // ─── Sessions (used by the integrations activity timeline) ────────────
  //
  // /v1/sessions returns the user's full session set with metadata; we
  // filter client-side. For active integrations this is fine — sessions are
  // bounded per user — but a future paged endpoint with provider-side
  // filtering would be cleaner. Lives on IntegrationsApi directly because
  // it's not provider-scoped.

  async listSessions(opts: { limit?: number } = {}): Promise<SessionSummary[]> {
    const limit = opts.limit ?? 50;
    const r = await request<{ data: SessionSummary[] }>(
      this.basePath,
      `/v1/sessions?limit=${limit}`,
    );
    return r.data;
  }
}
