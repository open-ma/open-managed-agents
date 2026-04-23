// @open-managed-agents/integrations-ui
//
// React UI for managing 3rd-party integrations (Linear + Slack today; GitHub
// later). Pages are composed into apps/console via react-router routes.

export { IntegrationsLinearList } from "./pages/IntegrationsLinearList";
export { IntegrationsLinearWorkspace } from "./pages/IntegrationsLinearWorkspace";
export { IntegrationsLinearPublishWizard } from "./pages/IntegrationsLinearPublishWizard";
export { IntegrationsSlackList } from "./pages/IntegrationsSlackList";
export { IntegrationsSlackWorkspace } from "./pages/IntegrationsSlackWorkspace";
export { IntegrationsSlackPublishWizard } from "./pages/IntegrationsSlackPublishWizard";
export { IntegrationsApi } from "./api/client";
export type {
  LinearInstallation,
  LinearPublication,
  LinearSubmitCredentialsInput,
  SlackInstallation,
  SlackPublication,
  SlackSubmitCredentialsInput,
  PublishWizardInput,
  A1FormStep,
  A1InstallLink,
  HandoffLink,
} from "./api/types";
