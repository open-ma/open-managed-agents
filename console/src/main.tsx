import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { SessionsList } from "./pages/SessionsList";
import { SessionDetail } from "./pages/SessionDetail";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { VaultsList } from "./pages/VaultsList";
import { SkillsList } from "./pages/SkillsList";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<AgentsList />} />
            <Route path="agents/:id" element={<AgentDetail />} />
            <Route path="sessions" element={<SessionsList />} />
            <Route path="sessions/:id" element={<SessionDetail />} />
            <Route path="environments" element={<EnvironmentsList />} />
            <Route path="skills" element={<SkillsList />} />
            <Route path="vaults" element={<VaultsList />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>
);
