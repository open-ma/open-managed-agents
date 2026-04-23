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
import { VaultsList } from "./pages/VaultsList";
import { SkillsList } from "./pages/SkillsList";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { ModelCardsList } from "./pages/ModelCardsList";
import { ApiKeysList } from "./pages/ApiKeysList";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AgentsList />} />
            <Route path="agents/:id" element={<AgentDetail />} />
            <Route path="sessions" element={<SessionsList />} />
            <Route path="sessions/:id" element={<SessionDetail />} />
            <Route path="environments" element={<EnvironmentsList />} />
            <Route path="skills" element={<SkillsList />} />
            <Route path="vaults" element={<VaultsList />} />
            <Route path="memory" element={<MemoryStoresList />} />
            <Route path="model-cards" element={<ModelCardsList />} />
            <Route path="api-keys" element={<ApiKeysList />} />
            <Route path="integrations/linear" element={<IntegrationsLinearList />} />
            <Route
              path="integrations/linear/publish"
              element={<IntegrationsLinearPublishPage />}
            />
            <Route
              path="integrations/linear/installations/:id"
              element={<IntegrationsLinearWorkspace />}
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
            <Route path="*" element={<Navigate to="/agents" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  </StrictMode>
);
