import type { EmbeddingProvider } from "../ports";

/**
 * Cloudflare Workers AI implementation of {@link EmbeddingProvider}.
 * Uses Google's EmbeddingGemma-300m (multilingual, ~768-dim). The model id
 * is `embeddinggemma-300m` (one word, sized suffix) — `embedding-gemma`
 * with a hyphen is a 5007 "no such model" error on the AI binding.
 */
export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly ai: Ai,
    private readonly model: string = "@cf/google/embeddinggemma-300m",
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
