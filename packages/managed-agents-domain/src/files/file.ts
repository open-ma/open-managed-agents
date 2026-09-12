export interface FileScope {
  id: string;
  type: "session";
}

/** Exact publication provenance for a durable copy of a session output. Recorded
 * when publication occurs; readers must never infer these IDs from timestamps. */
export interface FileOrigin {
  type: "session_output";
  sessionId: string;
  environmentId: string;
  turnId: string;
  path: string;
}

export interface FileMetadata {
  id: string;
  createdAt: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadable?: boolean;
  scope?: FileScope | null;
  origin?: FileOrigin | null;
}
