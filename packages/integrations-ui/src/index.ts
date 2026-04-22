// @open-managed-agents/integrations-ui
//
// React UI for managing 3rd-party integrations (Linear today; Slack/GitHub
// later). Pages are composed into apps/console via react-router routes.

export { IntegrationsLinearList } from "./pages/IntegrationsLinearList";
export { IntegrationsLinearWorkspace } from "./pages/IntegrationsLinearWorkspace";
export { IntegrationsLinearPublishWizard } from "./pages/IntegrationsLinearPublishWizard";
export { IntegrationsGitHubList } from "./pages/IntegrationsGitHubList";
export { IntegrationsGitHubWorkspace } from "./pages/IntegrationsGitHubWorkspace";
export { IntegrationsGitHubBindWizard } from "./pages/IntegrationsGitHubBindWizard";
export { IntegrationsApi } from "./api/client";
export { StatusPill, type PublicationStatus } from "./components/StatusPill";
export { relativeTime } from "./components/relativeTime";
export type {
  LinearInstallation,
  LinearPublication,
  PublishWizardInput,
  A1FormStep,
  A1InstallLink,
  HandoffLink,
  GitHubInstallation,
  GitHubPublication,
  GitHubA1FormStep,
  GitHubA1InstallLink,
  SessionSummary,
  GitHubSessionMetadata,
} from "./api/types";
