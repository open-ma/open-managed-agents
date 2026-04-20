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
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string | null;
  mode: string;
  status: string;
  persona_name: string;
  persona_avatar_url: string | null;
  slash_command: string | null;
  capabilities: string;
  session_granularity: string;
  is_default_agent: number;
  created_at: number;
  unpublished_at: number | null;
}

export class D1PublicationRepo implements PublicationRepo {
  constructor(
    private readonly db: D1Database,
    private readonly ids: IdGenerator,
  ) {}

  async get(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_publications WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_publications WHERE installation_id = ?
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
        `SELECT * FROM linear_publications WHERE user_id = ? AND agent_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(userId, agentId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async getDefaultForInstallation(installationId: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM linear_publications
         WHERE installation_id = ? AND is_default_agent = 1 AND status = 'live'
         LIMIT 1`,
      )
      .bind(installationId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listSlashCommands(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_publications
         WHERE installation_id = ? AND slash_command IS NOT NULL AND status = 'live'`,
      )
      .bind(installationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO linear_publications (
           id, user_id, agent_id, installation_id, environment_id, mode, status,
           persona_name, persona_avatar_url, slash_command, capabilities,
           session_granularity, is_default_agent, created_at, unpublished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        row.userId,
        row.agentId,
        row.installationId,
        row.environmentId,
        row.mode,
        row.status,
        row.persona.name,
        row.persona.avatarUrl,
        row.slashCommand,
        JSON.stringify([...row.capabilities]),
        row.sessionGranularity,
        row.isDefaultAgent ? 1 : 0,
        now,
      )
      .run();
    return {
      id,
      userId: row.userId,
      agentId: row.agentId,
      installationId: row.installationId,
      environmentId: row.environmentId,
      mode: row.mode,
      status: row.status,
      persona: row.persona,
      slashCommand: row.slashCommand,
      capabilities: row.capabilities,
      sessionGranularity: row.sessionGranularity,
      isDefaultAgent: row.isDefaultAgent,
      createdAt: now,
      unpublishedAt: null,
    };
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_publications SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_publications SET capabilities = ? WHERE id = ?`)
      .bind(JSON.stringify([...capabilities]), id)
      .run();
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_publications
         SET persona_name = ?, persona_avatar_url = ? WHERE id = ?`,
      )
      .bind(persona.name, persona.avatarUrl, id)
      .run();
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_publications
         SET status = 'unpublished', unpublished_at = ? WHERE id = ?`,
      )
      .bind(at, id)
      .run();
  }

  private toDomain(row: Row): Publication {
    const caps = JSON.parse(row.capabilities) as CapabilityKey[];
    return {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      installationId: row.installation_id,
      environmentId: row.environment_id ?? "",
      mode: row.mode as PublicationMode,
      status: row.status as PublicationStatus,
      persona: { name: row.persona_name, avatarUrl: row.persona_avatar_url },
      slashCommand: row.slash_command,
      capabilities: new Set(caps),
      sessionGranularity: row.session_granularity as SessionGranularity,
      isDefaultAgent: row.is_default_agent === 1,
      createdAt: row.created_at,
      unpublishedAt: row.unpublished_at,
    };
  }
}
