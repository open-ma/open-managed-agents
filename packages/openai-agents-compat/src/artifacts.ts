import { OpenAIAgentsProtocolError, type OpenAIAgentsOperationRequest, type OpenAIAgentsOperationResponse } from "@open-managed-agents/openai-agents-api";
import type { FilesApplicationPort, FileMetadataView } from "@open-managed-agents/managed-agents-application/ports/files";
import type { FileOrigin } from "@open-managed-agents/managed-agents-application";

export interface ArtifactDependencies {
  files: FilesApplicationPort;
  requireSession(sessionId: string): Promise<void>;
}
export interface ArtifactPublicationInput {
  sessionId: string;
  environmentId: string;
  turnId: string;
  path: string;
  mimeType: string;
  content: Uint8Array;
}
export interface ArtifactPublicationDependencies {
  files: FilesApplicationPort;
  /** Must verify the exact recorded turn is completed and belongs to this session
   * and environment before persisting bytes. A runtime timestamp is insufficient. */
  requireCompletedTurn(origin: FileOrigin): Promise<void>;
}

function publishedInSession(file: FileMetadataView, sessionId: string): file is FileMetadataView & { origin: FileOrigin } {
  const origin = file.origin;
  return origin?.type === "session_output" && origin.sessionId === sessionId && file.scope?.type === "session" && file.scope.id === sessionId &&
    [origin.turnId, origin.environmentId].every(value => typeof value === "string" && value.trim().length > 0) && typeof origin.path === "string" && origin.path.startsWith("/");
}

function artifactResource(file: FileMetadataView & { origin: FileOrigin }) {
  return { id: file.id, object: "agent.session.artifact" as const, created_at: Math.floor(Date.parse(file.createdAt) / 1000), session_id: file.origin.sessionId, environment_id: file.origin.environmentId, turn_id: file.origin.turnId, path: file.origin.path, size_bytes: file.sizeBytes };
}

/** Internal publication hook: copies output bytes to an ordinary durable File,
 * with provenance stored atomically alongside that File's existing metadata. */
export async function publishSessionArtifact(deps: ArtifactPublicationDependencies, input: ArtifactPublicationInput) {
  const origin: FileOrigin = { type: "session_output", sessionId: input.sessionId, environmentId: input.environmentId, turnId: input.turnId, path: input.path };
  if ([origin.sessionId, origin.environmentId, origin.turnId].some(value => !value?.trim()) || !origin.path.startsWith("/")) throw new OpenAIAgentsProtocolError(400, "Artifact publication requires exact completed-turn provenance");
  await deps.requireCompletedTurn(origin);
  const result = await deps.files.uploadFile({ filename: input.path.split("/").at(-1) ?? "", mimeType: input.mimeType, content: input.content.slice(), origin });
  if (result.type === "invalid_request") throw new OpenAIAgentsProtocolError(400, result.message);
  if (!publishedInSession(result.file, input.sessionId)) throw new OpenAIAgentsProtocolError(500, "File publication did not preserve its origin");
  return artifactResource(result.file);
}

export function createArtifactsHandler(deps: ArtifactDependencies) {
  const retrieve = async (sessionId: string, artifactId: string) => {
    const result = await deps.files.retrieveFileMetadata({ fileId: artifactId });
    if (result.type !== "found" || !publishedInSession(result.file, sessionId)) throw new OpenAIAgentsProtocolError(404, "Session artifact not found", undefined, "resource_not_found");
    return result.file;
  };
  return async (request: OpenAIAgentsOperationRequest): Promise<OpenAIAgentsOperationResponse> => {
    const sessionId = request.params.session_id!;
    await deps.requireSession(sessionId);
    if (request.operation === "sessions.artifacts.list") {
      const files: Array<FileMetadataView & { origin: FileOrigin }> = [];
      const cursors = new Set<string>();
      let afterId: string | undefined;
      for (;;) {
        const result = await deps.files.listFiles({ scopeId: sessionId, pageSize: 100, ...(afterId && { afterId }) });
        if (result.type === "invalid_request") throw new OpenAIAgentsProtocolError(400, result.message);
        files.push(...result.page.files.filter((file): file is FileMetadataView & { origin: FileOrigin } => publishedInSession(file, sessionId)));
        if (!result.page.hasMore) break;
        const next = result.page.lastId;
        if (!next || cursors.has(next)) throw new OpenAIAgentsProtocolError(500, "File application returned an invalid cursor");
        cursors.add(next);
        afterId = next;
      }
      const direction = request.query.order === "asc" ? 1 : -1;
      files.sort((a, b) => direction * (Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
      const anchor = request.query.after == null ? -1 : files.findIndex(file => file.id === request.query.after);
      if (request.query.after != null && anchor < 0) throw new OpenAIAgentsProtocolError(400, "The after cursor does not belong to this session", "after");
      const selected = files.slice(anchor + 1).filter(file => request.query.environment_id == null || file.origin.environmentId === request.query.environment_id);
      const limit = Number(request.query.limit ?? 20);
      return { body: { data: selected.slice(0, limit).map(artifactResource), has_more: selected.length > limit } };
    }
    const file = await retrieve(sessionId, request.params.artifact_id!);
    switch (request.operation) {
      case "sessions.artifacts.retrieve": return { body: artifactResource(file) };
      case "sessions.artifacts.delete": {
        const deleted = await deps.files.deleteFile({ fileId: file.id });
        if (deleted.type !== "deleted") throw new OpenAIAgentsProtocolError(404, "Session artifact not found");
        return { body: { id: file.id, object: "agent.session.artifact.deleted", deleted: true } };
      }
      case "sessions.artifacts.content": {
        const downloaded = await deps.files.downloadFile({ fileId: file.id });
        if (downloaded.type !== "found") throw new OpenAIAgentsProtocolError(404, "Session artifact not found");
        return { binary: new Uint8Array(downloaded.file.content), headers: { "content-type": downloaded.file.mimeType, "content-length": String(downloaded.file.content.length), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` } };
      }
      default: throw new OpenAIAgentsProtocolError(404, "Unknown artifact operation");
    }
  };
}
