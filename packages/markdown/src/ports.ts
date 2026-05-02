// Runtime-agnostic markdown converter port.
//
// `web_fetch` (apps/agent/src/harness/tools.ts) takes an arbitrary URL,
// fetches the bytes, and asks "convert this to markdown". On Cloudflare
// Workers AI does it via env.AI.toMarkdown(); on Node we'll plug in
// turndown / pdf-parse / mammoth (separate adapter, not in this package
// yet — added when CFless lands).
//
// The port deliberately mirrors Workers AI's input/output shape (one
// {name, blob} item per input, returns either a single result or an
// array of results) so the CF adapter is a literal passthrough and the
// existing call site needs no shape massage.

export interface ToMarkdownInput {
  /** Suggestion to the converter — used as a hint when MIME is ambiguous. */
  name: string;
  blob: Blob;
}

export interface ToMarkdownResult {
  /** "markdown" on success; converter-specific otherwise. */
  format: string;
  /** The markdown body when format === "markdown"; otherwise undefined. */
  data?: string;
  /** Human-readable error from the converter. */
  error?: string;
}

/**
 * A converter takes one or more name+blob inputs and returns the
 * corresponding markdown(s). Either a single {ToMarkdownResult} OR an array
 * of them is allowed; callers that pass multiple inputs SHOULD expect an
 * array, but adapters MAY return a single object for one-input cases.
 */
export type ToMarkdownProvider = (
  inputs: ToMarkdownInput[],
) => Promise<ToMarkdownResult | ToMarkdownResult[]>;
