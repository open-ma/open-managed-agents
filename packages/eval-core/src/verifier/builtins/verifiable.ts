// Verifiable Verifier — wraps one of the named, pure-function Scorers
// from packages/eval-core/src/scorers/scorers.ts as a Verifier.
//
// This is the bridge that activates the scorer library: existing
// `bashExit` / `fileWritten` / `idleNoError` / `regex` / etc. become
// referenceable from a JSON RewardSpec via:
//
//   { "type": "verifiable", "scorer": "bashExit", "opts": { "expectedCode": 0 } }
//
// SCORER_REGISTRY is the only piece that knows about each scorer's
// constructor signature — keeps scorers.ts unchanged (they remain
// pure higher-order functions) and gives JSON callers a typed entry
// point. Adding a new scorer = appending to SCORER_REGISTRY.

import type { Trajectory } from "../../trajectory/types.js";
import type { Score, Scorer } from "../../scorers/types.js";
import type { Verifier, VerifierContext, VerifiableRewardSpec } from "../types.js";
import {
  agentMessageContains,
  bashExit,
  bashOutputMarker,
  bashSuccess,
  fileWritten,
  gaiaMatch,
  idleNoError,
  includes,
  regex,
  threadCreated,
  toolNotUsed,
  toolUsed,
} from "../../scorers/scorers.js";

type ScorerFactory = (opts: Record<string, unknown>) => Scorer;

/**
 * Mapping table: scorer name (used in JSON RewardSpec.scorer) →
 * factory that adapts `opts` into the existing scorer signature.
 *
 * Entries here cover the 11 production scorers shipped today. New
 * additions: keep the entry minimal (just unwrap `opts.<arg>`); the
 * scorer factory in scorers.ts stays the source of truth.
 */
export const SCORER_REGISTRY: Record<string, ScorerFactory> = {
  includes: (opts) =>
    includes(String(opts.target ?? ""), { caseInsensitive: opts.caseInsensitive !== false }),

  regex: (opts) => {
    const pattern = opts.pattern;
    const flags = typeof opts.flags === "string" ? opts.flags : "";
    if (pattern instanceof RegExp) return regex(pattern);
    return regex(new RegExp(String(pattern ?? ""), flags));
  },

  toolUsed: (opts) => toolUsed(String(opts.name ?? "")),
  toolNotUsed: (opts) => toolNotUsed(String(opts.name ?? "")),

  bashExit: (opts) => {
    const expectedCode = typeof opts.expectedCode === "number" ? opts.expectedCode : 0;
    return bashExit(expectedCode);
  },
  bashSuccess: () => bashSuccess(),
  bashOutputMarker: (opts) => bashOutputMarker(String(opts.marker ?? "")),

  fileWritten: (opts) => fileWritten(String(opts.filePath ?? opts.path ?? "")),

  idleNoError: () => idleNoError(),

  agentMessageContains: (opts) =>
    agentMessageContains(String(opts.target ?? ""), {
      caseInsensitive: opts.caseInsensitive !== false,
    }),

  threadCreated: (opts) =>
    threadCreated(typeof opts.minCount === "number" ? opts.minCount : 1),

  gaiaMatch: (opts) => gaiaMatch(String(opts.expected ?? "")),
};

export class VerifiableVerifier implements Verifier {
  readonly id: string;
  private readonly scorer: Scorer;

  constructor(spec: VerifiableRewardSpec, _ctx: VerifierContext) {
    const factory = SCORER_REGISTRY[spec.scorer];
    if (!factory) {
      throw new Error(
        `verifiable: unknown scorer "${spec.scorer}" — known: ${Object.keys(SCORER_REGISTRY).join(", ")}`,
      );
    }
    this.id = `verifiable.${spec.scorer}.v1`;
    this.scorer = factory(spec.opts ?? {});
  }

  async check(traj: Trajectory): Promise<Score> {
    return Promise.resolve(this.scorer(traj));
  }
}
