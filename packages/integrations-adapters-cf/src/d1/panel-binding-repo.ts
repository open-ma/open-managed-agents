import type { PanelBinding, PanelBindingRepo } from "@open-managed-agents/integrations-core";

interface Row {
  oma_session_id: string;
  panel_agent_session_id: string;
  updated_at: number;
  last_elicitation_at: number | null;
}

export class D1PanelBindingRepo implements PanelBindingRepo {
  constructor(private readonly db: D1Database) {}

  async get(omaSessionId: string): Promise<PanelBinding | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_oma_panel_binding WHERE oma_session_id = ?`)
      .bind(omaSessionId)
      .first<Row>();
    if (!row) return null;
    return {
      omaSessionId: row.oma_session_id,
      panelAgentSessionId: row.panel_agent_session_id,
      updatedAt: row.updated_at,
      lastElicitationAt: row.last_elicitation_at,
    };
  }

  async set(omaSessionId: string, panelAgentSessionId: string, updatedAt: number): Promise<void> {
    // UPSERT — second enter_panel call just switches the binding atomically.
    // Switching panels also clears any pending elicitation stamp; the new
    // panel is a fresh context.
    await this.db
      .prepare(
        `INSERT INTO linear_oma_panel_binding
           (oma_session_id, panel_agent_session_id, updated_at, last_elicitation_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(oma_session_id) DO UPDATE SET
           panel_agent_session_id = excluded.panel_agent_session_id,
           updated_at = excluded.updated_at,
           last_elicitation_at = NULL`,
      )
      .bind(omaSessionId, panelAgentSessionId, updatedAt)
      .run();
  }

  async stampElicitation(omaSessionId: string, ts: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_oma_panel_binding
           SET last_elicitation_at = ?
         WHERE oma_session_id = ?`,
      )
      .bind(ts, omaSessionId)
      .run();
  }

  async clear(omaSessionId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM linear_oma_panel_binding WHERE oma_session_id = ?`)
      .bind(omaSessionId)
      .run();
  }
}
