// Node OutputsAdapter — wraps a local outputs root (default
// `./data/session-outputs`) as the per-session outputs surface that
// `@open-managed-agents/http-routes`'s sessions package consumes.
// CF wires its R2-backed equivalent in apps/main; this is the
// Node-side companion.

import { createReadStream } from "node:fs";
import { stat as fsStat, readdir as fsReaddir, rm as fsRm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { Readable } from "node:stream";
import { guessSessionOutputMime } from "@open-managed-agents/shared";

export function nodeOutputsAdapter(outputsRoot: string) {
  return {
    async list(tenantId: string, sessionId: string) {
      const dir = resolvePath(outputsRoot, tenantId, sessionId);
      let entries: string[];
      try {
        entries = await fsReaddir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: Array<{
        filename: string;
        size_bytes: number;
        uploaded_at: string;
        media_type: string;
      }> = [];
      for (const filename of entries) {
        try {
          const st = await fsStat(join(dir, filename));
          if (!st.isFile()) continue;
          out.push({
            filename,
            size_bytes: st.size,
            uploaded_at: new Date(st.mtimeMs).toISOString(),
            media_type: guessSessionOutputMime(filename),
          });
        } catch {
          /* skip unreadable entries */
        }
      }
      return out;
    },
    async read(tenantId: string, sessionId: string, filename: string) {
      const full = join(resolvePath(outputsRoot, tenantId, sessionId), filename);
      let st;
      try {
        st = await fsStat(full);
        if (!st.isFile()) return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      const nodeStream = createReadStream(full);
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
      return {
        body: webStream,
        size: st.size,
        contentType: guessSessionOutputMime(filename),
      };
    },
    async deleteAll(tenantId: string, sessionId: string) {
      const dir = resolvePath(outputsRoot, tenantId, sessionId);
      await fsRm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
