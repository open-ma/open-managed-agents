import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHarnessInSandboxCertificationPlan,
  credentialPathsForHarness,
  redactCertificationOutput,
} from "./harness-in-sandbox-live-certification.mjs";

test("the first-class harness-in-sandbox matrix is explicit and excludes Hermes", () => {
  assert.deepEqual(buildHarnessInSandboxCertificationPlan(), [
    { id: "pi-acp", credential: "deepseek", nativeState: "pi" },
    { id: "codex-acp", credential: "codex-oauth", nativeState: "codex" },
    { id: "mcode", credential: "deepseek", nativeState: "mcode" },
  ]);
});

test("credential mounts are harness-scoped and never include a whole home directory", () => {
  assert.deepEqual(credentialPathsForHarness("pi-acp", "/home/tester"), []);
  assert.deepEqual(credentialPathsForHarness("codex-acp", "/home/tester"), [
    "/home/tester/.codex/auth.json",
  ]);
  assert.deepEqual(credentialPathsForHarness("mcode", "/home/tester"), []);
  assert.throws(
    () => credentialPathsForHarness("hermes", "/home/tester"),
    /unsupported harness/i,
  );
});

test("live certification reports redact every runtime credential", () => {
  assert.equal(
    redactCertificationOutput(
      "deepseek=secret-deepseek codex=secret-codex",
      ["secret-deepseek", "secret-codex"],
    ),
    "deepseek=<redacted> codex=<redacted>",
  );
});
