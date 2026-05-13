import type { SqlClient } from "@open-managed-agents/sql-client";

import type {
  CapabilityKey,
  CapabilitySet,
  IdGenerator,
  NewPublication,
  Persona,
  Publication,
  PublicationMode,
  PublicationRepo,
  PublicationStatus,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string | null;
  mode: string;
  status: string;
  persona_name: string;
  persona_avatar_url: string | null;
  capabilities: string;
  session_granularity: string;
  created_at: number;
  unpublished_at: number | null;
}

/**
 * D1 publication repo for GitHub. Mirrors SqlPublicationRepo verbatim but
 * targets `github_publications`. See SqlGitHubInstallationRepo for the
 * rationale behind the per-provider split.
 */
export class SqlGitHubPublicationRepo implements PublicationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_publications WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM github_publications WHERE installation_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(installationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM github_publications WHERE user_id = ? AND agent_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(userId, agentId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO github_publications (
           id, tenant_id, user_id, agent_id, installation_id, environment_id, mode, status,
           persona_name, persona_avatar_url, capabilities,
           session_granularity, created_at, unpublished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        row.tenantId,
        row.userId,
        row.agentId,
        row.installationId,
        row.environmentId,
        row.mode,
        row.status,
        row.persona.name,
        // D1 rejects undefined; coerce to null when persona has no avatar.
        row.persona.avatarUrl ?? null,
        JSON.stringify([...row.capabilities]),
        row.sessionGranularity,
        now,
      )
      .run();
    return {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      agentId: row.agentId,
      installationId: row.installationId,
      environmentId: row.environmentId,
      mode: row.mode,
      status: row.status,
      persona: row.persona,
      capabilities: row.capabilities,
      sessionGranularity: row.sessionGranularity,
      createdAt: now,
      unpublishedAt: null,
    };
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE github_publications SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await this.db
      .prepare(`UPDATE github_publications SET capabilities = ? WHERE id = ?`)
      .bind(JSON.stringify([...capabilities]), id)
      .run();
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_publications
         SET persona_name = ?, persona_avatar_url = ? WHERE id = ?`,
      )
      .bind(persona.name, persona.avatarUrl, id)
      .run();
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_publications
         SET status = 'unpublished', unpublished_at = ? WHERE id = ?`,
      )
      .bind(at, id)
      .run();
  }

  private toDomain(row: Row): Publication {
    const caps = JSON.parse(row.capabilities) as CapabilityKey[];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      installationId: row.installation_id,
      environmentId: row.environment_id ?? "",
      mode: row.mode as PublicationMode,
      status: row.status as PublicationStatus,
      persona: { name: row.persona_name, avatarUrl: row.persona_avatar_url },
      capabilities: new Set(caps),
      sessionGranularity: row.session_granularity as SessionGranularity,
      createdAt: row.created_at,
      unpublishedAt: row.unpublished_at,
    };
  }
}
