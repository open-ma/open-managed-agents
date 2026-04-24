// Cloudflare adapter wiring. Exports the KV implementation of
// OutboundSnapshotRepo plus a `createCfOutboundSnapshotService` factory that
// callers in apps/agent (SessionDO + outbound worker) use to instantiate the
// service.

export { KvOutboundSnapshotRepo } from "./cf";

import { KvOutboundSnapshotRepo } from "./cf";
import type { Logger } from "../ports";
import { OutboundSnapshotService } from "../service";

/**
 * Production wiring: build an OutboundSnapshotService backed by the
 * `CONFIG_KV` Cloudflare KV namespace. The snapshot lives next to the rest
 * of OMA's KV state today; future moves (e.g. a dedicated KV namespace, or
 * Redis for self-hosted) only touch this factory.
 */
export function createCfOutboundSnapshotService(
  env: { CONFIG_KV: KVNamespace },
  opts?: { logger?: Logger },
): OutboundSnapshotService {
  return new OutboundSnapshotService({
    repo: new KvOutboundSnapshotRepo(env.CONFIG_KV),
    logger: opts?.logger,
  });
}
