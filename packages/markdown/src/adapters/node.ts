// Node implementation of ToMarkdownProvider for CFless deployments.
//
// Lazy-imports `turndown` for HTML→markdown. Other formats (PDF, DOCX, etc.)
// fall through to a placeholder result the harness logs and skips. The
// CF Workers AI binding handles those formats natively; achieving parity
// on Node would require pdf-parse + mammoth + ... — added on demand.
//
// Driver dep is a peer with peerDependenciesMeta.optional so this package
// compiles without turndown installed:
//   pnpm add turndown @types/turndown -w   # at the deployment site

import type { ToMarkdownInput, ToMarkdownProvider, ToMarkdownResult } from "../ports";

interface TurndownService {
  turndown(html: string): string;
}

interface TurndownConstructor {
  new (opts?: { headingStyle?: string; codeBlockStyle?: string }): TurndownService;
}

let turndownPromise: Promise<TurndownConstructor> | null = null;

async function loadTurndown(): Promise<TurndownConstructor> {
  if (!turndownPromise) {
    turndownPromise = import(/* @vite-ignore */ "turndown" as string)
      .then((mod) => (mod.default ?? mod) as TurndownConstructor)
      .catch((err) => {
        throw new Error(
          `nodeToMarkdown: failed to load 'turndown' — ` +
            `pnpm add turndown @types/turndown (cause: ${String(err)})`,
        );
      });
  }
  return turndownPromise;
}

export interface NodeToMarkdownOptions {
  /** Override turndown service options. */
  turndown?: { headingStyle?: string; codeBlockStyle?: string };
}

/**
 * Build a ToMarkdownProvider that converts HTML to markdown via turndown.
 *
 * Inputs with content-type other than text/html return a placeholder
 * result with format!=="markdown" so the harness's web_fetch tool falls
 * back to its raw-curl path with a clear warning to the model.
 */
export function nodeToMarkdown(opts: NodeToMarkdownOptions = {}): ToMarkdownProvider {
  return async (inputs: ToMarkdownInput[]) => {
    const Turndown = await loadTurndown();
    const td = new Turndown({
      headingStyle: opts.turndown?.headingStyle ?? "atx",
      codeBlockStyle: opts.turndown?.codeBlockStyle ?? "fenced",
    });
    const out: ToMarkdownResult[] = [];
    for (const input of inputs) {
      const mime = input.blob.type || "text/html";
      if (!mime.includes("html") && !mime.includes("xml") && !mime.startsWith("text/")) {
        out.push({
          format: "unsupported",
          error: `nodeToMarkdown: ${mime} not supported on Node yet (add pdf-parse / mammoth / etc. to packages/markdown)`,
        });
        continue;
      }
      try {
        const html = await input.blob.text();
        const md = td.turndown(html);
        out.push({ format: "markdown", data: md });
      } catch (err) {
        out.push({ format: "error", error: (err as Error).message });
      }
    }
    return out.length === 1 ? out[0] : out;
  };
}
