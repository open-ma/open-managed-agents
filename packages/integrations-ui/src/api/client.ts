// Typed wrapper around fetch for /v1/integrations/* endpoints.
//
// Credentials are sent via session cookie (better-auth). The base path is
// configurable for tests; defaults to the Console's same-origin "".

import type {
  A1FormStep,
  A1InstallLink,
  HandoffLink,
  LinearInstallation,
  LinearPublication,
  PublishWizardInput,
} from "./types";

export interface IntegrationsApiOptions {
  basePath?: string;
}

export class IntegrationsApi {
  private readonly basePath: string;

  constructor(opts: IntegrationsApiOptions = {}) {
    this.basePath = opts.basePath ?? "";
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.basePath}${path}`, {
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

  // ─── List + manage ──────────────────────────────────────────────────

  async listInstallations(): Promise<LinearInstallation[]> {
    const r = await this.request<{ data: LinearInstallation[] }>(
      "/v1/integrations/linear/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<LinearPublication[]> {
    const r = await this.request<{ data: LinearPublication[] }>(
      `/v1/integrations/linear/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async getPublication(id: string): Promise<LinearPublication> {
    return this.request<LinearPublication>(
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
    return this.request<LinearPublication>(
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await this.request(
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  // ─── Install initiation (proxied through main → integrations gateway) ───

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return this.request<A1FormStep>("/v1/integrations/linear/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: {
    formToken: string;
    clientId: string;
    clientSecret: string;
    webhookSecret: string;
  }): Promise<A1InstallLink> {
    return this.request<A1InstallLink>("/v1/integrations/linear/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return this.request<HandoffLink>("/v1/integrations/linear/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }
}
