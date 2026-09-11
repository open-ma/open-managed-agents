import type { FileMetadata } from "../domain/file";
import type {
  DownloadFileQuery,
  DownloadFileResult,
  DeleteFileCommand,
  DeleteFileResult,
  FilesApplicationPort,
  ListFilesQuery,
  ListFilesResult,
  RetrieveFileMetadataQuery,
  RetrieveFileMetadataResult,
  UploadFileCommand,
  UploadFileResult,
} from "../ports/files";
import type { FileContentStore } from "@open-managed-agents/file-content-store";
import type { FileStore } from "@open-managed-agents/file-store";

export interface FilesApplicationServiceDependencies {
  workspaceId: string;
  store: FileStore;
  content: FileContentStore;
  clock: { now(): Date };
  ids: { nextFileId(): string };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export class FilesApplicationService
  implements FilesApplicationPort
{
  constructor(
    private readonly dependencies: FilesApplicationServiceDependencies,
  ) {}

  async uploadFile(command: UploadFileCommand): Promise<UploadFileResult> {
    if (command.filename.trim().length === 0) {
      return { type: "invalid_request", message: "Filename must not be empty" };
    }
    if (command.mimeType.trim().length === 0) {
      return { type: "invalid_request", message: "MIME type must not be empty" };
    }
    const origin = command.origin;
    if (origin !== undefined && (
      origin.type !== "session_output" ||
      [origin.sessionId, origin.environmentId, origin.turnId].some(value => typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) ||
      typeof origin.path !== "string" || !origin.path.startsWith("/") || origin.path.includes("\0") || origin.path.endsWith("/") || origin.path.split("/").includes("..")
    )) return { type: "invalid_request", message: "Output publication requires exact session, environment, turn and absolute file path provenance" };
    const file: FileMetadata = {
      id: this.dependencies.ids.nextFileId(),
      createdAt: this.dependencies.clock.now().toISOString(),
      filename: command.filename,
      mimeType: command.mimeType,
      sizeBytes: command.content.byteLength,
      downloadable: true,
      ...(origin !== undefined && { origin: { ...origin }, scope: { type: "session" as const, id: origin.sessionId } }),
    };
    const location = {
      workspaceId: this.dependencies.workspaceId,
      fileId: file.id,
    };
    await this.dependencies.content.put({
      ...location,
      content: command.content,
    });
    try {
      const inserted = await this.dependencies.store.insert({
        workspaceId: this.dependencies.workspaceId,
        file,
      });
      return { type: "uploaded", file: inserted };
    } catch (error) {
      await this.dependencies.content.delete(location);
      throw error;
    }
  }

  async retrieveFileMetadata(
    query: RetrieveFileMetadataQuery,
  ): Promise<RetrieveFileMetadataResult> {
    const file = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      fileId: query.fileId,
    });
    return file === null ? { type: "not_found" } : { type: "found", file };
  }

  async downloadFile(query: DownloadFileQuery): Promise<DownloadFileResult> {
    const file = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      fileId: query.fileId,
    });
    if (file === null) return { type: "not_found" };
    const content = await this.dependencies.content.get({
      workspaceId: this.dependencies.workspaceId,
      fileId: query.fileId,
    });
    if (content === null) {
      throw new Error(`File ${query.fileId} metadata exists without content`);
    }
    return {
      type: "found",
      file: {
        content,
        mimeType: file.mimeType,
        filename: file.filename,
      },
    };
  }

  async listFiles(query: ListFilesQuery): Promise<ListFilesResult> {
    if (query.beforeId !== undefined && query.afterId !== undefined) {
      return {
        type: "invalid_request",
        message: "beforeId and afterId may not be used together",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      ...(query.scopeId !== undefined && { scopeId: query.scopeId }),
      ...(query.beforeId !== undefined && {
        position: { fileId: query.beforeId, direction: "before" as const },
      }),
      ...(query.afterId !== undefined && {
        position: { fileId: query.afterId, direction: "after" as const },
      }),
    });
    const hasMore = records.length > pageSize;
    const files = hasMore ? records.slice(0, pageSize) : records;
    return {
      type: "page",
      page: {
        files,
        hasMore,
        firstId: files[0]?.id ?? null,
        lastId: files[files.length - 1]?.id ?? null,
      },
    };
  }

  async deleteFile(command: DeleteFileCommand): Promise<DeleteFileResult> {
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      fileId: command.fileId,
    });
    if (result.type === "not_found") return result;
    await this.dependencies.content.delete({
      workspaceId: this.dependencies.workspaceId,
      fileId: command.fileId,
    });
    return { type: "deleted", fileId: command.fileId };
  }
}
