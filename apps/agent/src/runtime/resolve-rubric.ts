// Resolve `user.define_outcome.rubric` to plain markdown text. AMA accepts:
//   - inline:  { type: "text", content }
//   - by ref:  { type: "file", file_id }   ← needs an R2 fetch
// Plus the legacy bare-string form, treated as inline text.
//
// Used by the outcome supervisor loop in session-do.ts. Resolution is
// lazy + cached on `state.outcome.rubric_content`: re-iteration after a
// `needs_revision` verdict reuses the cached text rather than re-fetching
// the file.
//
// Failure mode: returns `{ ok: false, error }`. Caller surfaces the
// failure as `span.outcome_evaluation_end.result = "failed"` with the
// error string in `explanation`.

import type { RubricSpec } from "@open-managed-agents/shared";
import { fileR2Key } from "@open-managed-agents/shared";

export type RubricResolution =
  | { ok: true; content: string }
  | { ok: false; error: string };

interface ResolveRubricDeps {
  /** Tenant the session belongs to — used to compute the R2 key for file
   *  rubrics. */
  tenantId: string;
  /** R2 bucket binding. When null/undefined the file branch fails fast. */
  filesBucket: R2Bucket | null | undefined;
}

export async function resolveRubric(
  rubric: string | RubricSpec | undefined,
  deps: ResolveRubricDeps,
): Promise<RubricResolution> {
  if (rubric === undefined) {
    return { ok: false, error: "no rubric provided" };
  }

  // Legacy: bare string is treated as inline text. Pre-Phase-4 callers
  // that haven't migrated keep working.
  if (typeof rubric === "string") {
    return rubric.trim().length > 0
      ? { ok: true, content: rubric }
      : { ok: false, error: "rubric is empty" };
  }

  if (rubric.type === "text") {
    if (!rubric.content || !rubric.content.trim()) {
      return { ok: false, error: "rubric.content is empty" };
    }
    return { ok: true, content: rubric.content };
  }

  if (rubric.type === "file") {
    if (!rubric.file_id) {
      return { ok: false, error: "rubric.file_id is empty" };
    }
    if (!deps.filesBucket) {
      return {
        ok: false,
        error: `rubric file fetch failed: FILES_BUCKET binding not configured`,
      };
    }
    const key = fileR2Key(deps.tenantId, rubric.file_id);
    try {
      const obj = await deps.filesBucket.get(key);
      if (!obj) {
        return {
          ok: false,
          error: `rubric file fetch failed: not found (file_id=${rubric.file_id})`,
        };
      }
      const text = await obj.text();
      if (!text.trim()) {
        return {
          ok: false,
          error: `rubric file fetch failed: empty body (file_id=${rubric.file_id})`,
        };
      }
      return { ok: true, content: text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `rubric file fetch failed: ${msg.slice(0, 200)}`,
      };
    }
  }

  // Exhaustive check — TypeScript will surface any missed RubricSpec branch.
  const _exhaustive: never = rubric;
  return {
    ok: false,
    error: `unknown rubric shape: ${JSON.stringify(_exhaustive)}`,
  };
}
