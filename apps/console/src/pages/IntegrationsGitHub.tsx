import {
  IntegrationsGitHubList,
  IntegrationsGitHubBindWizard,
  IntegrationsGitHubWorkspace,
} from "@open-managed-agents/integrations-ui";
import { useApi } from "../lib/api";

// Thin Console-side wrapper for the bind wizard. The wizard needs to know
// the user's agents and environments — those endpoints are owned by main, so
// we inject loaders here rather than baking endpoints into the UI package.

export function IntegrationsGitHubBindPage() {
  const { api } = useApi();
  return (
    <IntegrationsGitHubBindWizard
      loadAgents={async () => {
        const r = await api<{ data: Array<{ id: string; name: string }> }>(
          "/v1/agents?limit=200",
        );
        return r.data;
      }}
      loadEnvironments={async () => {
        const r = await api<{ data: Array<{ id: string; name: string }> }>(
          "/v1/environments?limit=200",
        );
        return r.data;
      }}
    />
  );
}

export { IntegrationsGitHubList, IntegrationsGitHubWorkspace };
