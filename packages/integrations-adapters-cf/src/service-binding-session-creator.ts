// Bridges integrations-core's SessionCreator port to apps/main via the
// `MAIN` service binding.
//
// The main worker exposes an internal endpoint that this adapter calls. The
// endpoint is gated by a shared header secret (set as a wrangler secret on
// both workers) so it can't be hit from the public internet even though both
// workers technically share a hostname.

import type {
  CreateSessionInput,
  SessionCreator,
  SessionEventInput,
  SessionId,
} from "@open-managed-agents/integrations-core";

export interface ServiceBindingSessionCreatorOptions {
  /** Secret shared with apps/main for the /v1/internal/* path family. */
  internalSecret: string;
  /** Path on the main worker. Defaults to "/v1/internal/sessions". */
  path?: string;
}

export class ServiceBindingSessionCreator implements SessionCreator {
  private readonly path: string;
  private readonly secret: string;

  constructor(
    private readonly main: Fetcher,
    opts: ServiceBindingSessionCreatorOptions,
  ) {
    if (!opts.internalSecret) {
      throw new Error("ServiceBindingSessionCreator: internalSecret required");
    }
    this.path = opts.path ?? "/v1/internal/sessions";
    this.secret = opts.internalSecret;
  }

  async create(input: CreateSessionInput): Promise<{ sessionId: SessionId }> {
    const res = await this.main.fetch(`http://main${this.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify({
        action: "create",
        userId: input.userId,
        agentId: input.agentId,
        environmentId: input.environmentId,
        vaultIds: input.vaultIds,
        mcpServers: input.mcpServers,
        metadata: input.metadata,
        initialEvent: input.initialEvent,
        githubRepoUrl: input.githubRepoUrl,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SessionCreator.create: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { sessionId: string };
    return { sessionId: data.sessionId };
  }

  async resume(userId: string, sessionId: SessionId, event: SessionEventInput): Promise<void> {
    const res = await this.main.fetch(`http://main${this.path}/${sessionId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": this.secret,
      },
      body: JSON.stringify({ userId, event }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SessionCreator.resume: ${res.status} ${body}`);
    }
  }
}
