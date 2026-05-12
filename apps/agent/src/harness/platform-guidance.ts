// Platform guidance appended to every agent's system prompt. Single source
// of truth — both CF SessionDO and the self-host Node main read these.
// Keep additions surgical: every line is sent on every turn for every
// agent, so it sits on the prompt-cache prefix path. Don't expand without
// proportional benefit.

export const authenticatedCommandGuidance =
  "For commands that may require authentication, prefer issuing a single command instead of a chained shell command. If an authenticated chained command fails, retry with a simpler single-command form.";

// Loop-stop guidance: prod incidents have shown agents retrying the same
// failing tool call indefinitely when an upstream credential is missing or
// an external API is down. Cap retries explicitly and require a structured
// failure report so the human (or calling system) can intervene.
export const loopStopGuidance =
  "If the same tool call fails three times in a row with substantively the same error, stop retrying. Report (a) what you were trying to do, (b) the exact error, and (c) what you would need to make progress (a missing credential, a corrected input, an upstream service to recover), then end the turn instead of looping.";

// AMA-aligned `/mnt/session/outputs/` convention: the platform mounts a
// per-session R2-backed (or host-fs-backed on Node) directory at this path.
// Files written here are listable via GET /v1/sessions/:id/outputs and
// downloadable by the caller. Without this hint, agents historically wrote
// final artefacts to /workspace/ where they vanish on container recycle.
export const sessionOutputsGuidance =
  "Files you write under `/mnt/session/outputs/` persist after the session ends and are downloadable by the user from the session's Files panel. Use this path for final artifacts the user should keep (reports, exports, generated docs, packaged code). Files written anywhere else (e.g. `/workspace/`) are scratch — they may be lost on container recycle and are not user-accessible.";

export const platformGuidance =
  `${authenticatedCommandGuidance}\n\n${loopStopGuidance}\n\n${sessionOutputsGuidance}`;

/**
 * Compose agent.system + platform guidance. If the agent has no system
 * prompt of its own, the guidance becomes the entire system prompt.
 */
export function composeSystemPrompt(rawSystemPrompt: string | null | undefined): string {
  const raw = rawSystemPrompt ?? "";
  return raw ? `${raw}\n\n${platformGuidance}` : platformGuidance;
}
