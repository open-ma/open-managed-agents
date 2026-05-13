// Node session-lifecycle hooks — Node companion to apps/main/src/lib/cf-session-lifecycle.ts.
//
// Implements only the hooks Node actually needs: `promoteSandboxFile`
// (close the 500 from POST /v1/sessions/:id/files), and `cascadeDeleteFiles`
// (delete file rows + blobs on session DELETE).
//
// CF-specific hooks (USAGE_METER gate, GitHub binding fast-path, vault
// credential refresh) stay undefined here — Node has no equivalent today.
// The package degrades gracefully: routes that look up `lifecycle?.foo`
// just skip the hook.

import {
  generateFileId,
  fileR2Key,
  logWarn,
} from "@open-managed-agents/shared";
import {
  toFileRecord,
  type FileService,
} from "@open-managed-agents/files-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import type { SessionLifecycleHooks } from "@open-managed-agents/http-routes";

export interface NodeSessionLifecycleDeps {
  files: FileService;
  filesBlob: BlobStore;
}

/** Build the per-process lifecycle hooks bundle for main-node. */
export function nodeSessionLifecycle(deps: NodeSessionLifecycleDeps): SessionLifecycleHooks {
  return {
    promoteSandboxFile: async ({
      tenantId,
      sessionId,
      sandboxPath,
      filename,
      mediaType,
      downloadable,
      bytes,
    }) => {
      const newFileId = generateFileId();
      const blobKey = fileR2Key(tenantId, newFileId);
      await deps.filesBlob.put(blobKey, bytes, {
        httpMetadata: { contentType: mediaType },
      });
      const row = await deps.files.create({
        id: newFileId,
        tenantId,
        sessionId,
        filename,
        mediaType,
        sizeBytes: bytes.byteLength,
        r2Key: blobKey,
        downloadable,
      });
      void sandboxPath;
      return toFileRecord(row);
    },
    cascadeDeleteFiles: async ({ tenantId, sessionId }) => {
      try {
        const orphans = await deps.files.deleteBySession({ sessionId });
        if (!orphans.length) return;
        await Promise.all(
          orphans.map((f) =>
            deps.filesBlob.delete(f.r2_key).catch((err) => {
              logWarn(
                {
                  op: "session.delete.blob_cleanup",
                  session_id: sessionId,
                  tenant_id: tenantId,
                  blob_key: f.r2_key,
                  err,
                },
                "orphan blob delete failed",
              );
            }),
          ),
        );
      } catch (err) {
        logWarn(
          {
            op: "session.delete.metadata_cleanup",
            session_id: sessionId,
            tenant_id: tenantId,
            err,
          },
          "files metadata cleanup failed",
        );
      }
    },
  };
}
