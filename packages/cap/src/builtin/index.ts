// Built-in CapSpec registry — every CLI CAP knows how to authenticate.
//
// Listed in the same order tests expect (alphabetical by cli_id). Add new
// CLIs by:
//   1. Writing a spec module in this directory
//   2. Importing + appending to `builtinSpecs` here
//   3. Adding a per-CLI integration test in test/unit/cli/<cli>.test.ts
//   4. Updating builtin-shape.test.ts if the new spec exercises a new
//      mode-specific invariant

import { awsSpec } from "./aws";
import { azSpec } from "./az";
import { cfSpec } from "./cf";
import { doctlSpec } from "./doctl";
import { dockerSpec } from "./docker";
import { flySpec } from "./fly";
import { gcloudSpec } from "./gcloud";
import { ghSpec } from "./gh";
import { gitSpec } from "./git";
import { glabSpec } from "./glab";
import { herokuSpec } from "./heroku";
import { kubectlSpec } from "./kubectl";
import { npmSpec } from "./npm";
import { vercelSpec } from "./vercel";
import type { CapSpec } from "../types";

export const builtinSpecs: readonly CapSpec[] = [
  awsSpec,
  azSpec,
  cfSpec,
  doctlSpec,
  dockerSpec,
  flySpec,
  gcloudSpec,
  ghSpec,
  gitSpec,
  glabSpec,
  herokuSpec,
  kubectlSpec,
  npmSpec,
  vercelSpec,
];

export {
  awsSpec,
  azSpec,
  cfSpec,
  doctlSpec,
  dockerSpec,
  flySpec,
  gcloudSpec,
  ghSpec,
  gitSpec,
  glabSpec,
  herokuSpec,
  kubectlSpec,
  npmSpec,
  vercelSpec,
};
