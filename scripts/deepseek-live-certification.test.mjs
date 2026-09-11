import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDeepSeekCertificationPlan,
  parseDeepSeekCredential,
  runDeepSeekCertification,
} from "./deepseek-live-certification.mjs";

test("DeepSeek certification covers Pi both outside and inside a real Docker sandbox", () => {
  assert.deepEqual(buildDeepSeekCertificationPlan(), [
    { id: "pi-harness-out", mode: "harness-out-sandbox" },
    { id: "pi-compaction-cache", mode: "harness-out-sandbox" },
    { id: "acp-native-resume-cache", mode: "harness-in-sandbox" },
    { id: "pi-acp-docker", mode: "harness-in-sandbox" },
  ]);
});

test("DeepSeek certification resolves the compaction probe through the package that owns tsx", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openma-deepseek-cert-"));
  const callsPath = join(directory, "calls.jsonl");
  const fakePnpm = join(directory, "pnpm");
  await writeFile(fakePnpm, [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> ${JSON.stringify(callsPath)}`,
  ].join("\n"));
  await chmod(fakePnpm, 0o755);
  try {
    await runDeepSeekCertification({
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "fixture-key",
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
    });
    const calls = (await readFile(callsPath, "utf8")).trim().split("\n");
    assert.equal(
      calls[1],
      "--filter @open-managed-agents/main-node exec tsx ../../scripts/probe-pi-deepseek-compaction-cache.ts",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DeepSeek credential parser accepts DSH yaml without retaining surrounding syntax", () => {
  assert.equal(
    parseDeepSeekCredential('other: value\nDEEPSEEK_API_KEY: "fixture-value"\n'),
    "fixture-value",
  );
  assert.equal(parseDeepSeekCredential("DEEPSEEK_API_KEY: 'single-value'\n"), "single-value");
  assert.equal(parseDeepSeekCredential("missing: true\n"), null);
});
