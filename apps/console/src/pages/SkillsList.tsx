import { useEffect, useRef, useState } from "react";
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
  encoding?: "utf8" | "base64";
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

// Mirrors the default UPLOAD_MAX_BYTES on the server (apps/main/src/quotas.ts).
// Self-hosters who raised the server limit will lose this client-side
// pre-rejection but the server will still enforce; that's an acceptable
// degradation for an unusual config.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

/* ---------- component ---------- */

export function SkillsList() {
  const { api } = useApi();

  /* list state */
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  /* create dialog */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createZip, setCreateZip] = useState<File | null>(null);
  const [createUploading, setCreateUploading] = useState(false);
  const [createDragOver, setCreateDragOver] = useState(false);
  const [createError, setCreateError] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  /* detail dialog */
  const [detail, setDetail] = useState<Skill | null>(null);
  const [detailFiles, setDetailFiles] = useState<SkillFile[]>([]);
  const [detailVersions, setDetailVersions] = useState<VersionSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  /* new version sub-form inside detail */
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [nvZip, setNvZip] = useState<File | null>(null);
  const [nvUploading, setNvUploading] = useState(false);
  const [nvDragOver, setNvDragOver] = useState(false);
  const [nvError, setNvError] = useState("");
  const nvInputRef = useRef<HTMLInputElement>(null);

  /* clawhub install */
  const [showClawHub, setShowClawHub] = useState(false);
  const [chQuery, setChQuery] = useState("");
  const [chResults, setChResults] = useState<Array<{ slug: string; name: string; description: string }>>([]);
  const [chSearching, setChSearching] = useState(false);
  const [chInstalling, setChInstalling] = useState("");
  const [chError, setChError] = useState("");

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
    setCreateZip(null);
    setCreateError("");
    setCreateDragOver(false);
    if (createInputRef.current) createInputRef.current.value = "";
  };

  // Validate file synchronously and set state. Returns true on success
  // so callers can know whether to clear the surrounding drop-zone state.
  const acceptCreateZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setCreateError(`"${file.name}" is not a .zip file`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setCreateError(
        `Zip is ${formatBytes(file.size)}, exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
      );
      return false;
    }
    setCreateError("");
    setCreateZip(file);
    return true;
  };

  const doCreate = async () => {
    if (!createZip) return;
    setCreateError("");
    setCreateUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", createZip);
      // Empty string here would override the server-side fallback to the
      // SKILL.md frontmatter name; only send when the user actually typed
      // something.
      if (createTitle.trim()) fd.append("display_title", createTitle.trim());
      await api("/v1/skills/upload", { method: "POST", body: fd });
      setShowCreate(false);
      resetCreate();
      load();
    } catch (e: any) {
      setCreateError(e?.message || "Upload failed");
    } finally {
      setCreateUploading(false);
    }
  };

  /* ---- detail ---- */

  const openDetail = async (skill: Skill) => {
    setDetail(skill);
    setDetailLoading(true);
    setShowNewVersion(false);
    setNvError("");
    setNvZip(null);
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
    setNvZip(null);
    setNvError("");
  };

  /* ---- new version ---- */

  const startNewVersion = () => {
    setNvError("");
    setNvZip(null);
    setNvDragOver(false);
    if (nvInputRef.current) nvInputRef.current.value = "";
    setShowNewVersion(true);
  };

  const acceptNvZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setNvError(`"${file.name}" is not a .zip file`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setNvError(
        `Zip is ${formatBytes(file.size)}, exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit`,
      );
      return false;
    }
    setNvError("");
    setNvZip(file);
    return true;
  };

  const doNewVersion = async () => {
    if (!detail || !nvZip) return;
    setNvError("");
    setNvUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", nvZip);
      await api(`/v1/skills/${detail.id}/versions/upload`, {
        method: "POST",
        body: fd,
      });
      setShowNewVersion(false);
      setNvZip(null);
      /* refresh both the list and this detail */
      load();
      const refreshed = await api<Skill>(`/v1/skills/${detail.id}`);
      openDetail(refreshed);
    } catch (e: any) {
      setNvError(e?.message || "Upload failed");
    } finally {
      setNvUploading(false);
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

  /* ---- clawhub ---- */

  const searchClawHub = async () => {
    if (!chQuery.trim()) return;
    setChSearching(true);
    setChError("");
    try {
      const res = await api<{ data: Array<{ slug: string; name: string; description: string }> }>(
        `/v1/clawhub/search?q=${encodeURIComponent(chQuery)}`
      );
      setChResults(res.data || []);
    } catch (e: any) {
      setChError(e.message || "Search failed");
      setChResults([]);
    } finally {
      setChSearching(false);
    }
  };

  const installFromClawHub = async (slug: string) => {
    setChInstalling(slug);
    setChError("");
    try {
      await api("/v1/clawhub/install", {
        method: "POST",
        body: JSON.stringify({ slug }),
      });
      setShowClawHub(false);
      setChQuery("");
      setChResults([]);
      load();
    } catch (e: any) {
      setChError(e.message || "Install failed");
    } finally {
      setChInstalling("");
    }
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
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowClawHub(true)}>
            ClawHub
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            + New skill
          </Button>
        </div>
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
                Upload a skill folder as a .zip with SKILL.md at the root.
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
          if (createUploading) return;
          setShowCreate(false);
          resetCreate();
        }}
        title="Upload Custom Skill"
        subtitle="Upload an Anthropic-style skill folder packaged as a .zip."
        maxWidth="max-w-xl"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={createUploading}
              onClick={() => {
                setShowCreate(false);
                resetCreate();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={doCreate}
              disabled={!createZip || createUploading}
              loading={createUploading}
              loadingLabel="Uploading..."
            >
              Upload
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

          {/* Drop zone */}
          <DropZone
            file={createZip}
            dragOver={createDragOver}
            onDragOver={(over) => setCreateDragOver(over)}
            onFile={(f) => acceptCreateZip(f)}
            onClear={() => {
              setCreateZip(null);
              if (createInputRef.current) createInputRef.current.value = "";
            }}
            inputRef={createInputRef}
            disabled={createUploading}
          />

          {/* Display Title (optional override) */}
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Display Title{" "}
              <span className="text-fg-subtle">
                (optional — falls back to SKILL.md <code>name</code>)
              </span>
            </label>
            <input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              className={inputCls}
              placeholder="Leave blank to use the skill's own name"
              disabled={createUploading}
            />
          </div>

          <p className="text-xs text-fg-subtle">
            The zip must contain <code>SKILL.md</code> at the root, or one
            top-level folder containing it (the common case when you
            <code> zip -r my-skill.zip my-skill</code>).
          </p>
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
                      <div className="bg-bg-surface px-3 py-1.5 border-b border-border text-xs font-mono text-fg-muted flex items-center justify-between">
                        <span className="truncate">{f.filename}</span>
                        {f.encoding === "base64" && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-subtle">
                            binary
                          </span>
                        )}
                      </div>
                      {f.encoding === "base64" ? (
                        <p className="px-3 py-2 text-xs italic text-fg-subtle">
                          Binary file — not previewed.
                        </p>
                      ) : (
                        <pre className="px-3 py-2 text-xs font-mono text-fg-muted whitespace-pre-wrap max-h-60 overflow-y-auto leading-relaxed">
                          {f.content}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* New Version sub-form */}
            {showNewVersion && (
              <div className="border border-border-strong rounded-lg p-4 bg-bg-surface/50 space-y-3">
                <h3 className="text-sm font-medium text-fg">
                  Upload New Version
                </h3>
                {nvError && (
                  <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                    {nvError}
                  </div>
                )}
                <DropZone
                  file={nvZip}
                  dragOver={nvDragOver}
                  onDragOver={(over) => setNvDragOver(over)}
                  onFile={(f) => acceptNvZip(f)}
                  onClear={() => {
                    setNvZip(null);
                    if (nvInputRef.current) nvInputRef.current.value = "";
                  }}
                  inputRef={nvInputRef}
                  disabled={nvUploading}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={nvUploading}
                    onClick={() => {
                      setShowNewVersion(false);
                      setNvZip(null);
                      setNvError("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={doNewVersion}
                    disabled={!nvZip || nvUploading}
                    loading={nvUploading}
                    loadingLabel="Uploading..."
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

      {/* ===== ClawHub Dialog ===== */}
      <Modal
        open={showClawHub}
        onClose={() => { setShowClawHub(false); setChQuery(""); setChResults([]); setChError(""); }}
        title="Install from ClawHub"
        subtitle="Search and install community skills from clawhub.ai"
        maxWidth="max-w-2xl"
        footer={
          <Button variant="ghost" onClick={() => { setShowClawHub(false); setChQuery(""); setChResults([]); setChError(""); }}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          {chError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {chError}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={chQuery}
              onChange={(e) => setChQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") searchClawHub(); }}
              className={inputCls + " flex-1"}
              placeholder="Search skills... e.g. git, docker, research"
              autoFocus
            />
            <Button onClick={searchClawHub} disabled={chSearching || !chQuery.trim()}>
              {chSearching ? "Searching..." : "Search"}
            </Button>
          </div>
          {chResults.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden max-h-80 overflow-y-auto">
              {chResults.map((s) => (
                <div key={s.slug} className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-bg-surface transition-colors">
                  <div className="min-w-0">
                    <div className="font-medium text-fg text-sm">{s.name || s.slug}</div>
                    <div className="text-xs text-fg-subtle font-mono">{s.slug}</div>
                    {s.description && <div className="text-xs text-fg-muted mt-0.5 line-clamp-2">{s.description}</div>}
                  </div>
                  <button
                    onClick={() => installFromClawHub(s.slug)}
                    disabled={chInstalling === s.slug}
                    className="shrink-0 px-3 py-1 text-xs font-medium rounded-md bg-brand text-brand-fg hover:bg-brand-hover disabled:opacity-50 transition-colors"
                  >
                    {chInstalling === s.slug ? "Installing..." : "Install"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {chResults.length === 0 && chQuery && !chSearching && (
            <p className="text-sm text-fg-subtle text-center py-4">No results. Try a different search term.</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ---------- DropZone ---------- */

interface DropZoneProps {
  file: File | null;
  dragOver: boolean;
  onDragOver: (over: boolean) => void;
  onFile: (file: File) => boolean;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

function DropZone({
  file,
  dragOver,
  onDragOver,
  onFile,
  onClear,
  inputRef,
  disabled,
}: DropZoneProps) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDragOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) onDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        onDragOver(false);
      }}
      onDrop={handleDrop}
      className={[
        "border-2 border-dashed rounded-lg px-4 py-6 text-center transition-colors",
        dragOver
          ? "border-brand bg-brand/5"
          : "border-border bg-bg-surface/30",
        disabled ? "opacity-60 pointer-events-none" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-left">
            <div className="text-sm font-medium text-fg truncate">{file.name}</div>
            <div className="text-xs text-fg-subtle">{formatBytes(file.size)}</div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-fg-muted">
            Drag &amp; drop a <code>.zip</code>, or
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </Button>
        </div>
      )}
    </div>
  );
}
