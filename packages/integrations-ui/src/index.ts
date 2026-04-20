// @open-managed-agents/integrations-ui
//
// React UI for managing 3rd-party integrations (Linear today; Slack/GitHub
// later). Pages are composed into apps/console via react-router routes.

export { IntegrationsLinearList } from "./pages/IntegrationsLinearList";
export { IntegrationsLinearWorkspace } from "./pages/IntegrationsLinearWorkspace";
export { IntegrationsLinearPublishWizard } from "./pages/IntegrationsLinearPublishWizard";
export { IntegrationsApi } from "./api/client";
export type {
  LinearInstallation,
  LinearPublication,
  PublishWizardInput,
  A1FormStep,
  A1InstallLink,
  HandoffLink,
} from "./api/types";
