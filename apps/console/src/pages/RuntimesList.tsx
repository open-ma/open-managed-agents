import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";
import { ListPage } from "../components/ListPage";

interface LocalSkill {
  id: string;
  name?: string;
  description?: string;
  source?: "global" | "plugin" | "project";
  source_label?: string;
}

interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: Array<{ id: string; binary?: string }>;
  /** Per-acp-agent-id list of skills daemon detected on the user's machine.
   *  Populated from ~/.claude/skills/ + ~/.claude/plugins (asterisk)/skills/
   *  for the Claude Code agent. Use this to show users what's locally
   *  available + as the source for the per-agent blocklist
   *  (AgentConfig.runtime_binding.local_skill_blocklist). */
  local_skills?: Record<string, LocalSkill[]>;
  version: string;
  status: "online" | "offline";
  last_heartbeat: number | null;
  created_at: number;
}

/** Local Runtimes — user-registered laptops/VMs running `oma bridge daemon`.
 *  Each runtime can host ACP-compatible agents. An OMA agent with
 *  `harness: "acp-proxy"` and `runtime_binding` set delegates its loop
 *  to one of these. */
export function RuntimesList() {
  const { api } = useApi();
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInstructions, setShowInstructions] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setRuntimes((await api<{ runtimes: Runtime[] }>("/v1/runtimes")).runtimes);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // Auto-refresh every 15s so a freshly-attached daemon shows up without a
    // hard reload. Cheap query — single SELECT against runtimes.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const remove = async (id: string) => {
    if (!confirm("Revoke this runtime? Daemon on that machine will stop being able to attach.")) return;
    try {
      await api(`/v1/runtimes/${id}`, { method: "DELETE" });
      load();
    } catch { /* ignore */ }
  };

  return (
    <ListPage<Runtime>
      title="Local Runtimes"
      subtitle={
        <>
          Your own laptops or servers, registered with OMA. Bind an agent to a runtime to run its turns
          on your hardware via a local ACP child. OMA promotes <strong>Claude Code</strong>,
          <strong> Codex</strong>, <strong>OpenClaw</strong>, and <strong>Hermes</strong> as featured;
          the daemon also detects 30+ other agents from the
          <a href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer" className="underline hover:text-fg ml-1">
            official ACP Registry
          </a>.
        </>
      }
      createLabel="+ Connect machine"
      onCreate={() => setShowInstructions(true)}
      data={runtimes}
      loading={loading}
      getRowKey={(r) => r.id}
      emptyTitle="No runtimes connected"
      emptySubtitle={
        <>
          Run <code className="text-xs bg-bg-surface px-1 py-0.5 rounded">npx @openma/cli bridge setup</code> on the machine you want to connect.
        </>
      }
      columns={[
        {
          key: "hostname",
          label: "Hostname",
          render: (r) => {
            const totalSkills = Object.values(r.local_skills ?? {}).reduce(
              (n, arr) => n + (arr?.length ?? 0),
              0,
            );
            return (
              <>
                <div className="font-medium text-fg">{r.hostname}</div>
                <div className="text-xs text-fg-subtle font-mono">{r.id}</div>
                {totalSkills > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-fg-muted hover:text-fg select-none">
                      {totalSkills} local skill{totalSkills === 1 ? "" : "s"} detected
                    </summary>
                    <div className="mt-1.5 ml-2 space-y-1.5">
                      {Object.entries(r.local_skills ?? {}).map(([acpId, skills]) =>
                        !skills?.length ? null : (
                          <div key={acpId}>
                            <div className="text-fg-subtle text-[10px] uppercase tracking-wider mb-0.5">
                              for {acpId}
                            </div>
                            <ul className="space-y-0.5">
                              {skills.map((s) => (
                                <li key={`${acpId}/${s.source_label ?? ""}/${s.id}`} className="font-mono">
                                  <span className="text-fg">{s.id}</span>
                                  <span className="text-fg-subtle ml-1">
                                    ({s.source ?? "global"}{s.source_label ? `:${s.source_label}` : ""})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ),
                      )}
                    </div>
                  </details>
                )}
              </>
            );
          },
        },
        { key: "os", label: "OS", className: "text-fg-muted", render: (r) => r.os },
        {
          key: "status",
          label: "Status",
          render: (r) => (
            <span
              className={
                r.status === "online"
                  ? "inline-flex items-center gap-1.5 text-success text-xs font-medium"
                  : "inline-flex items-center gap-1.5 text-fg-subtle text-xs font-medium"
              }
            >
              <span
                className={
                  r.status === "online"
                    ? "w-1.5 h-1.5 rounded-full bg-success"
                    : "w-1.5 h-1.5 rounded-full bg-fg-subtle"
                }
              />
              {r.status}
            </span>
          ),
        },
        {
          key: "agents",
          label: "Agents detected",
          className: "font-mono text-xs text-fg-muted",
          render: (r) => (r.agents.length === 0 ? "—" : r.agents.map((a) => a.id).join(", ")),
        },
        {
          key: "heartbeat",
          label: "Heartbeat",
          className: "text-fg-muted text-xs",
          render: (r) => (r.last_heartbeat ? formatHeartbeat(r.last_heartbeat) : "—"),
        },
        {
          key: "actions",
          label: "Actions",
          className: "text-right",
          render: (r) => (
            <button
              onClick={() => remove(r.id)}
              className="text-xs text-fg-subtle hover:text-danger"
            >
              Revoke
            </button>
          ),
        },
      ]}
    >
      <Modal
        open={showInstructions}
        onClose={() => setShowInstructions(false)}
        title="Connect a local machine"
        footer={<Button onClick={() => setShowInstructions(false)}>Done</Button>}
      >
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            On the machine you want to connect, run:
          </p>
          <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
            <div className="text-fg select-all">npx @openma/cli@beta bridge setup</div>
          </div>
          <p className="text-fg-muted text-xs">
            Setup opens this browser for OAuth, writes credentials to{" "}
            <code className="bg-bg-surface px-1 rounded">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
            that keeps the daemon running across reboots. The daemon scans your <code className="bg-bg-surface px-1 rounded">$PATH</code> for
            ACP-compatible agents and reports them here.
          </p>
          <div>
            <p className="text-fg-muted text-xs mb-1.5">
              <strong>★ Featured agents</strong> — OMA's recommended set:
            </p>
            <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc font-mono">
              <li><span className="text-fg">claude-acp</span> · <code className="bg-bg-surface px-1 rounded">npx -y @agentclientprotocol/claude-agent-acp</code> (auto-installed if <code className="bg-bg-surface px-1 rounded">claude</code> is on PATH)</li>
              <li><span className="text-fg">codex-acp</span> · download from <a href="https://github.com/zed-industries/codex-acp/releases" target="_blank" rel="noreferrer" className="underline">zed-industries/codex-acp releases</a></li>
              <li><span className="text-fg">openclaw</span> · <code className="bg-bg-surface px-1 rounded">npm i -g openclaw</code> (uses <code className="bg-bg-surface px-1 rounded">openclaw acp</code> bridge)</li>
              <li><span className="text-fg">hermes</span> · <code className="bg-bg-surface px-1 rounded">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code></li>
            </ul>
          </div>
          <div>
            <p className="text-fg-muted text-xs mb-1.5">
              Setup auto-installs an ACP wrapper when an upstream binary is on <code className="bg-bg-surface px-1 rounded">$PATH</code>:
            </p>
            <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc">
              <li><code className="bg-bg-surface px-1 rounded">claude</code> → installs <code className="bg-bg-surface px-1 rounded">@agentclientprotocol/claude-agent-acp</code></li>
              <li><code className="bg-bg-surface px-1 rounded">codex</code> → installs <code className="bg-bg-surface px-1 rounded">@normahq/codex-acp-bridge</code> (drives codex over ACP)</li>
              <li><code className="bg-bg-surface px-1 rounded">gemini</code> missing → installs <code className="bg-bg-surface px-1 rounded">@google/gemini-cli</code> (ships ACP natively)</li>
            </ul>
          </div>
          <p className="text-fg-muted text-xs">
            30+ other agents (gemini, opencode, cline, cursor, kimi, qwen-code, …) come from the
            <a href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer" className="underline hover:text-fg ml-1">
              official ACP Registry
            </a> — daemon fetches the manifest at startup and any installed binary becomes selectable.
          </p>
        </div>
      </Modal>
    </ListPage>
  );
}

function formatHeartbeat(unixSeconds: number): string {
  const ago = Math.floor(Date.now() / 1000) - unixSeconds;
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}
