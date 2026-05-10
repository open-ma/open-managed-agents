import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./components/Toast";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { SessionsList } from "./pages/SessionsList";
import { SessionDetail } from "./pages/SessionDetail";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { EnvironmentDetail } from "./pages/EnvironmentDetail";
import { VaultsList } from "./pages/VaultsList";
import { SkillsList } from "./pages/SkillsList";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { MemoryStoreDetail } from "./pages/MemoryStoreDetail";
import { ModelCardsList } from "./pages/ModelCardsList";
import { ApiKeysList } from "./pages/ApiKeysList";
import { CliLogin } from "./pages/CliLogin";
import { RuntimesList } from "./pages/RuntimesList";
import { ConnectRuntime } from "./pages/ConnectRuntime";
import { EvalRunsList } from "./pages/EvalRunsList";
import { EvalRunDetail } from "./pages/EvalRunDetail";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
  IntegrationsLinearPatInstallPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsGitHubList,
  IntegrationsGitHubWorkspace,
  IntegrationsGitHubBindPage,
} from "./pages/IntegrationsGitHub";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";
import { consolePlugins } from "./plugins/registry";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route path="cli/login" element={<CliLogin />} />
          <Route path="connect-runtime" element={<ConnectRuntime />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AgentsList />} />
            <Route path="agents/:id" element={<AgentDetail />} />
            <Route path="sessions" element={<SessionsList />} />
            <Route path="sessions/:id" element={<SessionDetail />} />
            <Route path="evals" element={<EvalRunsList />} />
            <Route path="evals/:id" element={<EvalRunDetail />} />
            <Route path="environments" element={<EnvironmentsList />} />
            <Route path="environments/:id" element={<EnvironmentDetail />} />
            <Route path="skills" element={<SkillsList />} />
            <Route path="vaults" element={<VaultsList />} />
            <Route path="memory" element={<MemoryStoresList />} />
            <Route path="memory/:id" element={<MemoryStoreDetail />} />
            <Route path="model-cards" element={<ModelCardsList />} />
            <Route path="api-keys" element={<ApiKeysList />} />
            <Route path="runtimes" element={<RuntimesList />} />
            <Route path="integrations/linear" element={<IntegrationsLinearList />} />
            <Route
              path="integrations/linear/publish"
              element={<IntegrationsLinearPublishPage />}
            />
            <Route
              path="integrations/linear/install-pat"
              element={<IntegrationsLinearPatInstallPage />}
            />
            <Route
              path="integrations/linear/installations/:id"
              element={<IntegrationsLinearWorkspace />}
            />
            <Route path="integrations/github" element={<IntegrationsGitHubList />} />
            <Route
              path="integrations/github/bind"
              element={<IntegrationsGitHubBindPage />}
            />
            <Route
              path="integrations/github/installations/:id"
              element={<IntegrationsGitHubWorkspace />}
            />
            <Route path="integrations/slack" element={<IntegrationsSlackList />} />
            <Route
              path="integrations/slack/publish"
              element={<IntegrationsSlackPublishPage />}
            />
            <Route
              path="integrations/slack/installations/:id"
              element={<IntegrationsSlackWorkspace />}
            />
            {/* Plugin-contributed routes (hosted-only extensions). Default
                empty in OSS — hosted deploy overlay replaces
                plugins/registry.ts to inject billing / etc. */}
            {consolePlugins.flatMap((p) =>
              (p.routes ?? []).map((r) => (
                <Route key={`${p.id}:${r.path}`} path={r.path} element={r.element} />
              )),
            )}
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  </StrictMode>
);
