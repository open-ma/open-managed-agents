import type { FileMetadata, FileScope, FileOrigin } from "../domain/file";

export type FileScopeView = FileScope;
export type FileMetadataView = FileMetadata;

export interface ListFilesQuery {
  pageSize?: number;
  beforeId?: string;
  afterId?: string;
  scopeId?: string;
}

export interface FilesPage {
  files: FileMetadataView[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
}

export interface RetrieveFileMetadataQuery {
  fileId: string;
}

export interface UploadFileCommand {
  filename: string;
  mimeType: string;
  content: Uint8Array;
  /** Internal output publication only. Public uploads do not populate provenance. */
  origin?: FileOrigin;
}

export interface DeleteFileCommand {
  fileId: string;
}

export interface DownloadFileQuery {
  fileId: string;
}

export interface DownloadedFileView {
  content: Uint8Array;
  mimeType: string;
  filename?: string;
}

export type ListFilesResult =
  | { type: "page"; page: FilesPage }
  | { type: "invalid_request"; message: string };

export type RetrieveFileMetadataResult =
  | { type: "found"; file: FileMetadataView }
  | { type: "not_found" };

export type UploadFileResult =
  | { type: "uploaded"; file: FileMetadataView }
  | { type: "invalid_request"; message: string };

export type DeleteFileResult =
  | { type: "deleted"; fileId: string }
  | { type: "not_found" };

export type DownloadFileResult =
  | { type: "found"; file: DownloadedFileView }
  | { type: "not_found" };

export interface FilesApplicationPort {
  listFiles(query: ListFilesQuery): Promise<ListFilesResult>;
  retrieveFileMetadata(query: RetrieveFileMetadataQuery): Promise<RetrieveFileMetadataResult>;
  uploadFile(command: UploadFileCommand): Promise<UploadFileResult>;
  deleteFile(command: DeleteFileCommand): Promise<DeleteFileResult>;
  downloadFile(query: DownloadFileQuery): Promise<DownloadFileResult>;
}
