/** Stable identity of one Managed Agents work item and its Session. */
export interface RuntimeResourceScope {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
  workId: string;
}
