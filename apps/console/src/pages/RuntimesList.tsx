import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/Button";
import { Modal } from "../components/Modal";

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
 *  Each runtime can host ACP-compatible agents (Claude Code, Codex, etc.).
 *  An OMA agent with `harness: "acp-proxy"` and `runtime_binding` set delegates
 *  its loop to one of these. */
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
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg">
            Local Runtimes
          </h1>
          <p className="text-fg-muted text-sm">
            Your own laptops or servers, registered with OMA. Bind an agent to a runtime to run its turns
            on your hardware using a local ACP agent (Claude Code today; more coming) instead of OMA's cloud.
          </p>
        </div>
        <Button
          onClick={() => setShowInstructions(true)}
          className="shrink-0 whitespace-nowrap"
        >
          + Connect machine
        </Button>
      </div>

      {loading ? (
        <div className="text-fg-subtle text-sm py-8 text-center">Loading…</div>
      ) : runtimes.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle">
          <p className="text-lg mb-1">No runtimes connected</p>
          <p className="text-sm">
            Run <code className="text-xs bg-bg-surface px-1 py-0.5 rounded">npx @openma/cli bridge setup</code> on the machine you want to connect.
          </p>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg-surface text-fg-subtle text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-2.5">Hostname</th>
                <th className="text-left px-4 py-2.5">OS</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Agents detected</th>
                <th className="text-left px-4 py-2.5">Heartbeat</th>
                <th className="text-right px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map((r) => {
                const totalSkills = Object.values(r.local_skills ?? {}).reduce(
                  (n, arr) => n + (arr?.length ?? 0),
                  0,
                );
                return (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-bg-surface transition-colors align-top"
                >
                  <td className="px-4 py-3">
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
                            )
                          )}
                        </div>
                      </details>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">{r.os}</td>
                  <td className="px-4 py-3">
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
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                    {r.agents.length === 0 ? "—" : r.agents.map((a) => a.id).join(", ")}
                  </td>
                  <td className="px-4 py-3 text-fg-muted text-xs">
                    {r.last_heartbeat
                      ? formatHeartbeat(r.last_heartbeat)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(r.id)}
                      className="text-xs text-fg-subtle hover:text-danger"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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
            that keeps the daemon running across reboots. If you have{" "}
            <code className="bg-bg-surface px-1 rounded">claude</code> installed, setup will also install the ACP wrapper
            (<code className="bg-bg-surface px-1 rounded">@agentclientprotocol/claude-agent-acp</code>) for you. The runtime appears
            here as <span className="text-success">online</span> within a few seconds of the daemon attaching.
          </p>
        </div>
      </Modal>
    </div>
  );
}

function formatHeartbeat(unixSeconds: number): string {
  const ago = Math.floor(Date.now() / 1000) - unixSeconds;
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}
