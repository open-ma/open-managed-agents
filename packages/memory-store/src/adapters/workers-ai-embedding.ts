import type { EmbeddingProvider } from "../ports";

/**
 * Cloudflare Workers AI implementation of {@link EmbeddingProvider}.
 * Uses Google's embedding-gemma model (matches what apps/main was already
 * doing pre-refactor; tweak the model id here to swap globally).
 */
export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly ai: Ai,
    private readonly model: string = "@cf/google/embedding-gemma",
  ) {}

  async embed(text: string): Promise<number[] | null> {
    const result = (await this.ai.run(this.model as keyof AiModels, {
      text: [text],
    } as any)) as { data: number[][] };
    const vec = result.data?.[0];
    if (!vec || vec.length === 0) throw new Error("empty embedding");
    return vec;
  }
}

/**
 * Disabled provider — returns null so the service treats every write as
 * "vector index intentionally not wired". Used in dev/test environments
 * without an AI binding.
 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<number[] | null> {
    return null;
  }
}
