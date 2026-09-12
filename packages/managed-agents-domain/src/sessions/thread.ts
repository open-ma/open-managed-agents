import type { AgentModel, AgentOpenMaExtensions } from "../agents";
import type {
  AgentMcpServer,
  AgentSkill,
  AgentTool,
} from "../agents";
import type { SessionStatus, SessionUsage } from "./session";

export type SessionThreadAgent =
  | {
      type: "agent";
      id: string;
      description: string | null;
      mcpServers: AgentMcpServer[];
      model: AgentModel;
      name: string;
      openma?: AgentOpenMaExtensions;
      skills: AgentSkill[];
      system: string | null;
      tools: AgentTool[];
      version: number;
    }
  | { type: "advisor"; model: string };

export interface SessionThreadStats {
  activeSeconds?: number;
  durationSeconds?: number;
  startupSeconds?: number;
}

export interface SessionThread {
  id: string;
  agent: SessionThreadAgent;
  archivedAt: string | null;
  createdAt: string;
  parentThreadId: string | null;
  sessionId: string;
  stats: SessionThreadStats | null;
  status: SessionStatus;
  updatedAt: string;
  usage: SessionUsage | null;
}
