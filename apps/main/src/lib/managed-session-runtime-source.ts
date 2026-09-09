import type {
  FilesApplicationPort,
  SessionResource,
} from "@open-managed-agents/managed-agents-application";

interface ManagedSessionRuntimeRecord {
  id: string;
  environmentId: string;
  metadata: Readonly<Record<string, string>>;
  resources: readonly SessionResource[];
}

interface ManagedSessionRuntimeSource {
  find(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<ManagedSessionRuntimeRecord | null>;
}

type ManagedSessionFileSource = Pick<FilesApplicationPort, "downloadFile">;

interface ManagedMemorySnapshotSource {
  materialize(input: {
    workspaceId: string;
    sessionId: string;
    memoryStoreId: string;
  }): Promise<{ mountStoreId: string }>;
}

/** During a rolling migration some tenants can still be backed by the
 * legacy Session schema. Only that known absence is allowed to fall back;
 * operational database failures must remain visible. */
export async function withMissingManagedSessionSchemaFallback<T>(
  canonical: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await canonical();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table:\s*(?:main\.)?managed_sessions\b/i.test(message)) {
      throw error;
    }
    return fallback();
  }
}

export type ManagedSessionInputsResult =
  | {
      type: "found";
      session: {
        id: string;
        environmentId: string;
        metadata: Readonly<Record<string, string>>;
        resources: readonly SessionResource[];
      };
    }
  | { type: "not_found" };

export async function resolveManagedSessionInputs(
  source: ManagedSessionRuntimeSource,
  input: { workspaceId: string; sessionId: string },
): Promise<ManagedSessionInputsResult> {
  const session = await source.find(input);
  if (session === null) return { type: "not_found" };
  return {
    type: "found",
    session: {
      id: session.id,
      environmentId: session.environmentId,
      metadata: session.metadata,
      resources: session.resources,
    },
  };
}

export type ManagedSessionInputFileResult =
  | {
      type: "found";
      content: Uint8Array;
      filename?: string;
      mimeType: string;
    }
  | { type: "not_found" };

/** Authorizes a runtime file download against the current Session snapshot.
 * A service-binding caller cannot use this as a general workspace file oracle. */
export async function downloadManagedSessionInputFile(
  source: ManagedSessionRuntimeSource,
  files: ManagedSessionFileSource,
  input: { workspaceId: string; sessionId: string; fileId: string },
): Promise<ManagedSessionInputFileResult> {
  const session = await source.find({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
  if (
    session === null
    || !session.resources.some(
      (resource) => resource.type === "file" && resource.fileId === input.fileId,
    )
  ) {
    return { type: "not_found" };
  }
  const downloaded = await files.downloadFile({ fileId: input.fileId });
  if (downloaded.type !== "found") return { type: "not_found" };
  return {
    type: "found",
    content: downloaded.file.content,
    mimeType: downloaded.file.mimeType,
    ...(downloaded.file.filename === undefined
      ? {}
      : { filename: downloaded.file.filename }),
  };
}

export type ManagedSessionMemorySnapshotResult =
  | { type: "found"; mountStoreId: string }
  | { type: "not_found" };

/** Authorizes a canonical Memory snapshot against the current Session.
 * Canonical Memory content lives in the application store, so sandbox mounts
 * consume an immutable blob projection rather than assuming the API wrote the
 * legacy mutable R2 prefix. */
export async function materializeManagedSessionMemorySnapshot(
  source: ManagedSessionRuntimeSource,
  snapshots: ManagedMemorySnapshotSource,
  input: {
    workspaceId: string;
    sessionId: string;
    memoryStoreId: string;
    access: "read_only" | "read_write";
  },
): Promise<ManagedSessionMemorySnapshotResult> {
  const session = await source.find({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
  const attached = session?.resources.find(
    (resource) =>
      resource.type === "memory_store"
      && resource.memoryStoreId === input.memoryStoreId,
  );
  if (attached === undefined || attached.type !== "memory_store") {
    return { type: "not_found" };
  }
  if (input.access === "read_write" || attached.access === "read_write") {
    throw new Error(
      `Managed Memory Store ${input.memoryStoreId} is read-write, but canonical reverse synchronization is not configured`,
    );
  }
  const snapshot = await snapshots.materialize({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    memoryStoreId: input.memoryStoreId,
  });
  return { type: "found", mountStoreId: snapshot.mountStoreId };
}
