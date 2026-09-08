import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeepSeekCertificationPlan,
  parseDeepSeekCredential,
} from "./deepseek-live-certification.mjs";

test("DeepSeek certification covers harness-out, compaction, and harness-in native resume", () => {
  assert.deepEqual(buildDeepSeekCertificationPlan(), [
    { id: "pi-harness-out", mode: "harness-out-sandbox" },
    { id: "pi-compaction-cache", mode: "harness-out-sandbox" },
    { id: "acp-native-resume-cache", mode: "harness-in-sandbox" },
  ]);
});

test("DeepSeek credential parser accepts DSH yaml without retaining surrounding syntax", () => {
  assert.equal(
    parseDeepSeekCredential('other: value\nDEEPSEEK_API_KEY: "fixture-value"\n'),
    "fixture-value",
  );
  assert.equal(parseDeepSeekCredential("DEEPSEEK_API_KEY: 'single-value'\n"), "single-value");
  assert.equal(parseDeepSeekCredential("missing: true\n"), null);
});
