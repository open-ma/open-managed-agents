import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { FeishuIcon, GitHubIcon, LinearIcon, SlackIcon } from "../components/icons";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Button } from "@/components/ui/button";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";
import { useI18n } from "../i18n";

/** Shared publication shape across Linear / GitHub / Slack — they all
 *  expose the same id / status / mode / persona / workspace_name fields. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [showEdit, setShowEdit] = useState(false);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);

  // Single-resource fetches via TQ. `enabled: !!id` defers until the route
  // param is available; the publication queries inherit the same gate.
  // Each query runs independently — failures on the publication endpoints
  // (404 / not-installed) don't block the agent detail render, same as
  // the previous behavior where each had its own .catch.
  const enabled = !!id;
  const { data: managedAgent, error: agentError } = useApiQuery<Agent>(
    id ? `/v1/agents/${id}` : null,
    undefined,
    { enabled },
  );
  const { data: versionsRes } = useApiQuery<{ data: Agent[] }>(
    id ? `/v1/agents/${id}/versions` : null,
    undefined,
    { enabled },
  );
  // Reverse-lookup publications per provider. Each endpoint exists thanks
  // to the /linear/agents/:id/publications + /slack/agents/:id/publications
  // + /github/agents/:id/publications routes added on the main worker.
  const { data: linearRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/oma/integrations/linear/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: githubRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/oma/integrations/github/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: slackRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/oma/integrations/slack/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: feishuRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/oma/integrations/feishu/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );

  // Aux data for the edit dialog pickers — same sources as AgentsList.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await managedApi.agents.list({
          limit: 200,
          include_archived: true,
        });
        if (!cancelled) setAllAgents(all.data ?? []);
      } catch (e) {
        console.warn("[AgentDetail] /v1/agents aux fetch failed", e);
      }
      await Promise.allSettled([
        (async () => {
          const sk = await managedApi.skills.list({ limit: 200 });
          if (!cancelled) {
            setCustomSkills(
              (sk.data ?? []).map((skill) => ({
                id: skill.id,
                name: skill.display_title || skill.id,
                description: "",
              })),
            );
          }
        })().catch((e) => console.warn("[AgentDetail] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/oma/model_cards?limit=200");
          if (!cancelled) setModelCards(mc.data ?? []);
        })().catch((e) => console.warn("[AgentDetail] /v1/oma/model_cards aux fetch failed", e)),
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const agent = managedAgent;
  const versions = versionsRes?.data ?? [];
  // Filter to live publications only — same predicate the old useEffect ran.
  const linearPubs = useMemo(
    () => (linearRes?.data ?? []).filter((p) => p.status === "live"),
    [linearRes],
  );
  const githubPubs = useMemo(
    () => (githubRes?.data ?? []).filter((p) => p.status === "live"),
    [githubRes],
  );
  const slackPubs = useMemo(
    () => (slackRes?.data ?? []).filter((p) => p.status === "live"),
    [slackRes],
  );
  const feishuPubs = useMemo(
    () => (feishuRes?.data ?? []).filter((p) => p.status === "live"),
    [feishuRes],
  );

  const error = agentError instanceof Error ? agentError.message : agentError ? String(agentError) : "";

  const modelStr = (m: Agent["model"]) => typeof m === "string" ? m : `${m?.id} (${m?.speed || "standard"})`;

  const refreshAgent = () => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: [`/v1/agents/${id}`] });
    void queryClient.invalidateQueries({ queryKey: [`/v1/agents/${id}/versions`] });
    void queryClient.invalidateQueries({ queryKey: ["/v1/agents"] });
  };

  const archive = async () => {
    if (!confirm("Archive this agent?")) return;
    if (!id) return;
    await managedApi.agents.archive(id);
    nav("/agents");
  };

  if (error) return <div className="p-10 text-danger">Error: {error}</div>;
  if (!agent) return <div className="p-10 text-fg-subtle">Loading...</div>;

  const archived = !!agent.archived_at;

  return (
    <Page
      layout="rail"
      header={
        <PageHeader
          actions={
            <>
              {!archived && (
                <Button variant="outline" size="sm" onClick={() => setShowEdit(true)}>
                  {t.common.edit}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={archive} disabled={archived}>
                {t.common.archive}
              </Button>
            </>
          }
        />
      }
      rail={
        <section className="console-property-group" aria-label="Agent properties">
          <h2 className="console-property-group-title">Properties</h2>
          <dl className="console-property-list">
            <PropertyRow label="ID"><span className="font-mono">{agent.id}</span></PropertyRow>
            <PropertyRow label="Model">{modelStr(agent.model)}</PropertyRow>
            <PropertyRow label="Version">v{agent.version}</PropertyRow>
            <PropertyRow label="Tools">
              {(agent.tools || [])
                .map((tool: any) => tool.type === "custom" ? `Custom: ${tool.name}` : tool.type)
                .join(", ") || "None"}
            </PropertyRow>
            <PropertyRow label="Created">{new Date(agent.created_at).toLocaleString()}</PropertyRow>
            <PropertyRow label="Updated">
              {new Date(agent.updated_at || agent.created_at).toLocaleString()}
            </PropertyRow>
            {agent.archived_at && (
              <PropertyRow label="Archived">
                <span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span>
              </PropertyRow>
            )}
          </dl>
        </section>
      }
    >
      <div className="console-detail-stack">
        <header className="console-detail-title-block">
          <h1>{agent.name}</h1>
          {agent.description && <p>{agent.description}</p>}
        </header>

      {/* Integrations — one fold per provider so adding a 4th / 5th doesn't
          push the rest of the page below the viewport. Default-open when
          there's at least one live publication so the user sees what's wired
          up at a glance; otherwise default-closed. */}
      <section className="console-detail-section">
        <h2>Integrations</h2>
        <div className="console-integration-list">
          <IntegrationFold
            kind="linear"
            label="Linear"
            icon={<LinearIcon className="w-4 h-4" />}
            pubs={linearPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="github"
            label="GitHub"
            icon={<GitHubIcon className="w-4 h-4" />}
            pubs={githubPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="slack"
            label="Slack"
            icon={<SlackIcon className="w-4 h-4" />}
            pubs={slackPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="feishu"
            label="Feishu"
            icon={<FeishuIcon className="w-4 h-4" />}
            pubs={feishuPubs}
            agentId={agent.id}
          />
        </div>
      </section>

      {/* System prompt */}
      {agent.system && (
        <section className="console-detail-section">
          <h2>System Prompt</h2>
          <pre className="console-detail-code-block">
            {agent.system}
          </pre>
        </section>
      )}

      {/* Version history */}
      {versions.length > 0 && (
        <section className="console-detail-section">
          <h2>Version History</h2>
          <div className="console-detail-table-wrap">
            <Table className="console-detail-table">
              <TableHeader variant="wireless">
                <TableRow variant="wireless">
                  <TableHead>Version</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>System Prompt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => (
                  <TableRow variant="wireless" key={v.version}>
                    <TableCell>v{v.version}</TableCell>
                    <TableCell className="text-fg-muted">{modelStr(v.model)}</TableCell>
                    <TableCell className="max-w-xs truncate text-fg-muted">{v.system || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
      </div>

      <AgentFormDialog
        open={showEdit}
        onClose={() => setShowEdit(false)}
        agent={agent}
        onUpdated={() => {
          setShowEdit(false);
          refreshAgent();
        }}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
      />
    </Page>
  );
}

/**
 * One foldable provider section. Default-open when there's a live
 * publication, default-closed otherwise — opening an empty section
 * just to find the "Publish to X" link is wasteful.
 */
function IntegrationFold({
  kind,
  label,
  icon,
  pubs,
  agentId,
}: {
  kind: "linear" | "github" | "slack" | "feishu";
  label: string;
  icon: React.ReactNode;
  pubs: Pub[];
  agentId: string;
}) {
  return (
    <details
      open={pubs.length > 0}
      className="console-integration-fold [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="console-integration-summary">
        <span className="text-fg-muted shrink-0">{icon}</span>
        <span className="font-medium text-fg">{label}</span>
        <span className="ml-auto text-xs text-fg-subtle">
          {pubs.length === 0 ? "Not published" : `${pubs.length} live`}
        </span>
      </summary>
      <div className="console-integration-content">
        {pubs.length === 0 ? (
          <Link
            to={`/integrations/${kind}/publish?agent_id=${agentId}`}
            className="console-detail-link"
          >
            Publish to {label} →
          </Link>
        ) : (
          <>
            {pubs.map((p) => (
              <Link
                key={p.id}
                to={`/integrations/${kind}`}
                className="console-detail-link text-fg-muted hover:text-fg"
              >
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-success-subtle text-success">
                  Live
                </span>
                <span>
                  as <strong>{p.persona.name}</strong> in {p.workspace_name ?? `${label} workspace`}
                </span>
                {p.mode === "full" && (
                  <span className="text-xs text-fg-subtle">(full identity)</span>
                )}
              </Link>
            ))}
            <Link
              to={`/integrations/${kind}/publish?agent_id=${agentId}`}
              className="console-detail-link text-brand hover:underline"
            >
              + Publish to another workspace
            </Link>
          </>
        )}
      </div>
    </details>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="console-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
