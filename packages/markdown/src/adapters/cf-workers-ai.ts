// Cloudflare Workers AI implementation of ToMarkdownProvider.
//
// env.AI.toMarkdown([{ name, blob }]) returns either a single result or an
// array; we pass that through verbatim — the port shape mirrors the
// underlying API so consumers don't need an adapter-specific branch.

import type { ToMarkdownInput, ToMarkdownProvider, ToMarkdownResult } from "../ports";

/**
 * Wrap a Cloudflare Workers AI binding as a ToMarkdownProvider. Returns
 * undefined when the binding itself is missing (matches the existing
 * "AI optional" semantics in apps/agent/src/harness/tools.ts buildTools).
 */
export function cfWorkersAiToMarkdown(ai: Ai | undefined): ToMarkdownProvider | undefined {
  if (!ai) return undefined;
  return async (inputs: ToMarkdownInput[]) => {
    return (await ai.toMarkdown(inputs)) as ToMarkdownResult | ToMarkdownResult[];
  };
}
