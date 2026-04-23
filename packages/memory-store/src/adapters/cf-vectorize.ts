import type { VectorIndex, VectorMatch, VectorUpsertItem } from "../ports";

/**
 * Cloudflare Vectorize implementation of {@link VectorIndex}.
 *
 * Reminder on Vectorize semantics (see plan: cf-vectorize-async-upserts):
 *   - upsert is async; values become queryable a few seconds later. The
 *     promise resolves once the mutation is durably enqueued.
 *   - id is the dedupe key; same id overwrites. We use "{store_id}:{memory_id}".
 *   - query needs a query vector; metadata-only filters are supported but
 *     the only filter we use is store_id scoping.
 */
export class CfVectorIndex implements VectorIndex {
  constructor(private readonly index: VectorizeIndex) {}

  isAvailable(): boolean {
    return true;
  }

  async upsert(items: VectorUpsertItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.index.upsert(
      items.map((it) => ({
        id: it.id,
        values: it.values,
        // Vectorize's typed metadata is Record<string, scalar | array> at the
        // top level. Our port accepts arbitrary unknown values; cast at the
        // boundary — adapter is the right place to bridge type narrowness.
        metadata: it.metadata as Record<string, VectorizeVectorMetadata>,
      })),
    );
  }

  async query(
    values: number[],
    opts: { topK: number; filter?: Record<string, unknown> },
  ): Promise<VectorMatch[]> {
    const result = await this.index.query(values, {
      topK: opts.topK,
      filter: opts.filter as unknown as VectorizeVectorMetadataFilter,
      returnMetadata: "indexed",
    });
    return (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: m.metadata,
      values: m.values as number[] | undefined,
    }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }

  async getById(id: string): Promise<{ id: string; values: number[] | null; metadata?: Record<string, unknown> } | null> {
    const result = await this.index.getByIds([id]);
    const found = result[0];
    if (!found) return null;
    return {
      id: found.id,
      values: (found.values as number[] | undefined) ?? null,
      metadata: found.metadata,
    };
  }
}

/**
 * Disabled vector index — every method is a safe no-op, query returns []
 * and isAvailable() reports false so the service can short-circuit search
 * without mistaking "unconfigured" for "configured but empty".
 */
export class NoopVectorIndex implements VectorIndex {
  isAvailable(): boolean {
    return false;
  }
  async upsert(): Promise<void> {}
  async query(): Promise<VectorMatch[]> {
    return [];
  }
  async deleteByIds(): Promise<void> {}
  async getById(): Promise<null> {
    return null;
  }
}
