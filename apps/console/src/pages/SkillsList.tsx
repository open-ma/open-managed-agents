import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";

/* ---------- types ---------- */

interface Skill {
  id: string;
  display_title: string;
  name: string;
  description: string;
  source: "anthropic" | "custom";
  latest_version: number;
  created_at: string;
}

interface SkillFile {
  filename: string;
  content: string;
}

interface VersionSummary {
  version: number;
  created_at: string;
}

interface VersionDetail {
  version: number;
  created_at: string;
  files: SkillFile[];
}

/* ---------- constants ---------- */

const SKILL_TEMPLATE = `---
name: my-skill
description: Brief description of what this skill does and when to use it.
---

# My Custom Skill

## Instructions

[Step-by-step guidance for Claude to follow]

## Examples

[Concrete examples of using this skill]
`;

/* ---------- component ---------- */

export function SkillsList() {
  const { api } = useApi();

  /* list state */
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  /* create dialog */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createSkillMd, setCreateSkillMd] = useState(SKILL_TEMPLATE);
  const [createFiles, setCreateFiles] = useState<SkillFile[]>([]);
  const [createError, setCreateError] = useState("");

  /* detail dialog */
  const [detail, setDetail] = useState<Skill | null>(null);
  const [detailFiles, setDetailFiles] = useState<SkillFile[]>([]);
  const [detailVersions, setDetailVersions] = useState<VersionSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  /* new version sub-form inside detail */
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [nvSkillMd, setNvSkillMd] = useState("");
  const [nvFiles, setNvFiles] = useState<SkillFile[]>([]);
  const [nvError, setNvError] = useState("");

  /* ---- loaders ---- */

  const load = async () => {
    setLoading(true);
    try {
      setSkills((await api<{ data: Skill[] }>("/v1/skills")).data);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  /* ---- create ---- */

  const resetCreate = () => {
    setCreateTitle("");
    setCreateSkillMd(SKILL_TEMPLATE);
    setCreateFiles([]);
    setCreateError("");
  };

  const doCreate = async () => {
    setCreateError("");
    const files: SkillFile[] = [
      { filename: "SKILL.md", content: createSkillMd },
      ...createFiles,
    ];
    try {
      await api("/v1/skills", {
        method: "POST",
        body: JSON.stringify({ display_title: createTitle, files }),
      });
      setShowCreate(false);
      resetCreate();
      load();
    } catch (e: any) {
      setCreateError(e.message);
    }
  };

  /* ---- detail ---- */

  const openDetail = async (skill: Skill) => {
    setDetail(skill);
    setDetailLoading(true);
    setShowNewVersion(false);
    setNvError("");
    try {
      const [versionDetail, versionsRes] = await Promise.all([
        api<VersionDetail>(
          `/v1/skills/${skill.id}/versions/${skill.latest_version}`
        ),
        api<{ data: VersionSummary[] }>(`/v1/skills/${skill.id}/versions`),
      ]);
      setDetailFiles(versionDetail.files || []);
      setDetailVersions(versionsRes.data || []);
    } catch {
      setDetailFiles([]);
      setDetailVersions([]);
    }
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailFiles([]);
    setDetailVersions([]);
    setShowNewVersion(false);
  };

  /* ---- new version ---- */

  const startNewVersion = () => {
    /* pre-populate from current files */
    const skillMdFile = detailFiles.find((f) => f.filename === "SKILL.md");
    setNvSkillMd(skillMdFile?.content || SKILL_TEMPLATE);
    setNvFiles(detailFiles.filter((f) => f.filename !== "SKILL.md"));
    setNvError("");
    setShowNewVersion(true);
  };

  const doNewVersion = async () => {
    if (!detail) return;
    setNvError("");
    const files: SkillFile[] = [
      { filename: "SKILL.md", content: nvSkillMd },
      ...nvFiles,
    ];
    try {
      await api(`/v1/skills/${detail.id}/versions`, {
        method: "POST",
        body: JSON.stringify({ files }),
      });
      setShowNewVersion(false);
      /* refresh both the list and this detail */
      load();
      const refreshed = await api<Skill>(`/v1/skills/${detail.id}`);
      openDetail(refreshed);
    } catch (e: any) {
      setNvError(e.message);
    }
  };

  /* ---- delete ---- */

  const deleteSkill = async () => {
    if (!detail) return;
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    try {
      await api(`/v1/skills/${detail.id}`, { method: "DELETE" });
      closeDetail();
      load();
    } catch {}
  };

  /* ---- helpers ---- */

  const inputCls =
    "w-full border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-border-strong transition-colors bg-bg text-fg";

  const anthropicSkills = skills.filter((s) => s.source === "anthropic");
  const customSkills = skills.filter((s) => s.source === "custom");

  /* ---- render ---- */

  return (
    <div className="flex-1 overflow-y-auto p-8 lg:p-10">
      {/* header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight">
            Skills
          </h1>
          <p className="text-fg-muted text-sm">
            Manage pre-built and custom skills for your agents.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          + New skill
        </Button>
      </div>

      {loading ? (
        <div className="text-fg-subtle text-sm py-8 text-center">
          Loading...
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-16 text-fg-subtle border border-dashed border-border rounded-lg">
          <p className="text-lg mb-1">No skills yet</p>
          <p className="text-sm">
            Create a skill to give your agents domain expertise.
          </p>
        </div>
      ) : (
        <>
          {/* Anthropic built-in skills */}
          {anthropicSkills.length > 0 && (
            <>
              <h3 className="text-sm font-medium text-fg mb-3">
                Anthropic Pre-built Skills
              </h3>
              <div className="border border-border rounded-lg overflow-hidden mb-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                      <th className="text-left px-4 py-2.5">Name</th>
                      <th className="text-left px-4 py-2.5">Description</th>
                      <th className="text-left px-4 py-2.5">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anthropicSkills.map((s) => (
                      <tr
                        key={s.id}
                        className="border-t border-border"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {s.display_title || s.name}
                          </div>
                          <div className="text-xs text-fg-subtle font-mono">
                            {s.name}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-fg-muted">
                          {s.description}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-subtle text-warning">
                            built-in
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Custom skills */}
          <h3 className="text-sm font-medium text-fg mb-3">
            Custom Skills
          </h3>
          {customSkills.length === 0 ? (
            <div className="text-center py-12 text-fg-subtle border border-dashed border-border rounded-lg">
              <p className="text-sm mb-1">No custom skills yet</p>
              <p className="text-xs">
                Create a skill with a SKILL.md file to give your agents domain
                expertise.
              </p>
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5">Name</th>
                    <th className="text-left px-4 py-2.5">Description</th>
                    <th className="text-left px-4 py-2.5">Version</th>
                    <th className="text-left px-4 py-2.5">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {customSkills.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => openDetail(s)}
                      className="border-t border-border hover:bg-bg-surface cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {s.display_title || s.name}
                        </div>
                        <div className="text-xs text-fg-subtle font-mono">
                          {s.id}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-fg-muted max-w-xs truncate">
                        {s.description}
                      </td>
                      <td className="px-4 py-3 text-fg-muted">
                        v{s.latest_version}
                      </td>
                      <td className="px-4 py-3 text-fg-muted">
                        {new Date(s.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ===== Create Dialog ===== */}
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          resetCreate();
        }}
        title="New Custom Skill"
        subtitle="Create a SKILL.md with YAML frontmatter and optional resource files."
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreate(false);
                resetCreate();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={doCreate}
              disabled={!createTitle || !createSkillMd.trim()}
            >
              Create Skill
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {createError}
            </div>
          )}

          {/* Display Title */}
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Display Title
            </label>
            <input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              className={inputCls}
              placeholder="My Custom Skill"
            />
          </div>

          {/* SKILL.md */}
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              SKILL.md{" "}
              <span className="text-fg-subtle">
                (YAML frontmatter with name and description)
              </span>
            </label>
            <textarea
              value={createSkillMd}
              onChange={(e) => setCreateSkillMd(e.target.value)}
              rows={14}
              className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
            />
          </div>

          {/* Additional files */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm text-fg-muted">
                Additional Files{" "}
                <span className="text-fg-subtle">
                  ({createFiles.length})
                </span>
              </label>
              <button
                onClick={() =>
                  setCreateFiles([
                    ...createFiles,
                    { filename: "", content: "" },
                  ])
                }
                className="text-xs text-fg-muted hover:text-fg transition-colors"
              >
                + Add file
              </button>
            </div>
            {createFiles.map((f, i) => (
              <div
                key={i}
                className="border border-border rounded-lg p-3 mb-2"
              >
                <div className="flex items-center gap-2 mb-2">
                  <input
                    value={f.filename}
                    onChange={(e) => {
                      const updated = [...createFiles];
                      updated[i] = { ...updated[i], filename: e.target.value };
                      setCreateFiles(updated);
                    }}
                    className={`${inputCls} flex-1`}
                    placeholder="filename.txt"
                  />
                  <button
                    onClick={() =>
                      setCreateFiles(createFiles.filter((_, j) => j !== i))
                    }
                    className="px-2 py-2 text-fg-subtle hover:text-danger transition-colors text-lg leading-none"
                  >
                    ×
                  </button>
                </div>
                <textarea
                  value={f.content}
                  onChange={(e) => {
                    const updated = [...createFiles];
                    updated[i] = { ...updated[i], content: e.target.value };
                    setCreateFiles(updated);
                  }}
                  rows={4}
                  className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
                  placeholder="File content..."
                />
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* ===== Detail Dialog ===== */}
      <Modal
        open={!!detail}
        onClose={closeDetail}
        title={detail?.display_title || detail?.name || ""}
        subtitle={detail ? `${detail.id} · v${detail.latest_version}` : ""}
        maxWidth="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={closeDetail}>
            Close
          </Button>
        }
      >
        {detailLoading ? (
          <div className="text-fg-subtle text-sm py-8 text-center">
            Loading...
          </div>
        ) : detail ? (
          <div className="space-y-5">
            {/* Actions */}
            <div className="flex justify-end">
              <Button variant="danger" size="sm" onClick={deleteSkill}>
                Delete
              </Button>
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Display Title
                </label>
                <p className="text-sm font-medium">
                  {detail.display_title}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Name
                </label>
                <p className="text-sm font-mono">
                  {detail.name}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Description
                </label>
                <p className="text-sm text-fg-muted">
                  {detail.description}
                </p>
              </div>
              <div>
                <label className="text-xs text-fg-muted block mb-0.5">
                  Created
                </label>
                <p className="text-sm text-fg-muted">
                  {new Date(detail.created_at).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Usage hint */}
            <div>
              <label className="text-xs text-fg-muted block mb-1">
                Usage in Agent Config
              </label>
              <pre className="bg-bg-surface border border-border rounded-lg p-3 text-xs font-mono text-fg-muted">
{`"skills": [{ "type": "custom", "skill_id": "${detail.id}", "version": "latest" }]`}
              </pre>
            </div>

            {/* Files */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-fg-muted">
                  Files (v{detail.latest_version})
                </label>
                <button
                  onClick={startNewVersion}
                  className="text-xs text-fg-muted hover:text-fg transition-colors"
                >
                  + New version
                </button>
              </div>
              {detailFiles.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  No files in this version.
                </p>
              ) : (
                <div className="space-y-2">
                  {detailFiles.map((f, i) => (
                    <div
                      key={i}
                      className="border border-border rounded-lg overflow-hidden"
                    >
                      <div className="bg-bg-surface px-3 py-1.5 border-b border-border text-xs font-mono text-fg-muted">
                        {f.filename}
                      </div>
                      <pre className="px-3 py-2 text-xs font-mono text-fg-muted whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">
                        {f.content}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* New Version sub-form */}
            {showNewVersion && (
              <div className="border border-border-strong rounded-lg p-4 bg-bg-surface/50 space-y-3">
                <h3 className="text-sm font-medium text-fg">
                  Create New Version
                </h3>
                {nvError && (
                  <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                    {nvError}
                  </div>
                )}
                <div>
                  <label className="text-xs text-fg-muted block mb-1">
                    SKILL.md
                  </label>
                  <textarea
                    value={nvSkillMd}
                    onChange={(e) => setNvSkillMd(e.target.value)}
                    rows={10}
                    className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-fg-muted">
                      Additional Files ({nvFiles.length})
                    </label>
                    <button
                      onClick={() =>
                        setNvFiles([
                          ...nvFiles,
                          { filename: "", content: "" },
                        ])
                      }
                      className="text-xs text-fg-muted hover:text-fg transition-colors"
                    >
                      + Add file
                    </button>
                  </div>
                  {nvFiles.map((f, i) => (
                    <div
                      key={i}
                      className="border border-border rounded-lg p-3 mb-2 bg-bg"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          value={f.filename}
                          onChange={(e) => {
                            const updated = [...nvFiles];
                            updated[i] = {
                              ...updated[i],
                              filename: e.target.value,
                            };
                            setNvFiles(updated);
                          }}
                          className={`${inputCls} flex-1`}
                          placeholder="filename.txt"
                        />
                        <button
                          onClick={() =>
                            setNvFiles(
                              nvFiles.filter((_, j) => j !== i)
                            )
                          }
                          className="px-2 py-2 text-fg-subtle hover:text-danger transition-colors text-lg leading-none"
                        >
                          ×
                        </button>
                      </div>
                      <textarea
                        value={f.content}
                        onChange={(e) => {
                          const updated = [...nvFiles];
                          updated[i] = {
                            ...updated[i],
                            content: e.target.value,
                          };
                          setNvFiles(updated);
                        }}
                        rows={4}
                        className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
                        placeholder="File content..."
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setShowNewVersion(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={doNewVersion}
                    disabled={!nvSkillMd.trim()}
                  >
                    Publish Version
                  </Button>
                </div>
              </div>
            )}

            {/* Versions list */}
            <div>
              <label className="text-xs text-fg-muted block mb-2">
                Version History
              </label>
              {detailVersions.length === 0 ? (
                <p className="text-xs text-fg-subtle">
                  No version history available.
                </p>
              ) : (
                <div className="border border-border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                        <th className="text-left px-4 py-2">Version</th>
                        <th className="text-left px-4 py-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailVersions.map((v) => (
                        <tr
                          key={v.version}
                          className="border-t border-border"
                        >
                          <td className="px-4 py-2 font-mono text-xs">
                            v{v.version}
                            {v.version === detail.latest_version && (
                              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-success-subtle text-success">
                                latest
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-fg-muted text-xs">
                            {new Date(v.created_at).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
