import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { AgentDetail } from "./AgentDetail";

const agent = {
  id: "agent-1",
  name: "OpenMA Demo Agent",
  model: "test-model",
  system: "You are a concise assistant.",
  tools: [],
  version: 2,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
};

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/agents/agent-1") return { data: agent };
    if (path === "/v1/agents/agent-1/versions") return { data: { data: [agent] } };
    return { data: { data: [] } };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({
    api: vi.fn(async (path: string) =>
      path === "/v1/oma/runtimes" ? { runtimes: [] } : { data: [] },
    ),
  }),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}));

vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));

describe("AgentDetail Linear rail", () => {
  it("opens with the entity title in the body and keeps metadata in the rail", async () => {
    render(
      <MemoryRouter initialEntries={["/agents/agent-1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "OpenMA Demo Agent" }))
      .toBeInTheDocument();
    expect(screen.getByTestId("detail-layout")).toHaveAttribute("data-detail-layout", "rail");

    const rail = screen.getByTestId("detail-rail");
    expect(within(rail).getByText("ID")).toBeInTheDocument();
    expect(within(rail).getByText("test-model")).toBeInTheDocument();

    const body = screen.getByTestId("detail-body");
    expect(within(body).getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(within(body).getByRole("heading", { name: "System Prompt" })).toBeInTheDocument();
    expect(within(body).getByRole("heading", { name: "Version History" })).toBeInTheDocument();
  });
});
