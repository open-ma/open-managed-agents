import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultOfflineCertificationLanes,
  parseOfflineCertificationArguments,
  runOfflineCertification,
  runOfflineCertificationCli,
  selectOfflineCertificationProviders,
} from "./offline-certification.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

test("offline matrix runs every supported keyless provider lane", async () => {
  const observed = [];
  const report = await runOfflineCertification({
    cwd: repoRoot,
    commit: { sha: "abc123", dirty: false },
    execute: async (lane) => {
      observed.push(lane.provider);
      if (lane.provider === "modal") {
        return { exitCode: 1, stdout: "", stderr: "simulated failure" };
      }
      return { exitCode: 0, stdout: `${lane.provider} passed`, stderr: "" };
    },
  });

  assert.deepEqual(observed, [
    "blaxel",
    "cloudflare",
    "modal",
    "sprites",
    "superserve",
    "vercel",
  ]);
  assert.equal(report.kind, "openma.offline_certification");
  assert.deepEqual(report.summary, {
    total: 6,
    pass: 5,
    fail: 1,
    not_run_no_credential: 0,
  });
  assert.equal(report.results[2].status, "FAIL");
  assert.match(report.results[5].stdout, /vercel passed/);
});

test("offline lanes never declare credentials and call package certification scripts", () => {
  for (const lane of defaultOfflineCertificationLanes()) {
    assert.deepEqual(lane.credentialRequirements, []);
    assert.deepEqual(lane.command.slice(0, 2), ["pnpm", "--filter"]);
    assert.equal(lane.command.at(-1), "test:certification:offline");
  }
});

test("offline CLI selects providers, writes a private report, and returns failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "oma-offline-certification-"));
  const reportPath = join(root, "report.json");
  const output = [];
  try {
    const exitCode = await runOfflineCertificationCli({
      argv: ["--", "--providers", ",vercel,blaxel,", "--report", reportPath],
      cwd: root,
      commit: { sha: "feedface", dirty: false },
      execute: async (lane) => ({
        exitCode: lane.provider === "vercel" ? 9 : 0,
        stdout: "",
        stderr: lane.provider === "vercel" ? "failed" : "",
      }),
      stdout: { write: (value) => output.push(value) },
    });

    assert.equal(exitCode, 1);
    assert.match(output.join(""), /\[FAIL\] vercel exit=9/);
    assert.match(output.join(""), /report: .*report\.json/);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.results.map(({ provider }) => provider), ["vercel", "blaxel"]);
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline CLI validates options and empty selections", async () => {
  assert.equal(parseOfflineCertificationArguments([]).providers, undefined);
  assert.throws(
    () => parseOfflineCertificationArguments(["--wat"]),
    /unknown offline certification option/,
  );
  assert.throws(
    () => parseOfflineCertificationArguments(["--report", "--wat"]),
    /--report requires a value/,
  );
  assert.throws(
    () => selectOfflineCertificationProviders(defaultOfflineCertificationLanes(), ["unknown"]),
    /unknown certification providers: unknown/,
  );
  assert.equal(
    selectOfflineCertificationProviders(defaultOfflineCertificationLanes(), undefined).length,
    6,
  );
  await assert.rejects(
    runOfflineCertificationCli({
      argv: [],
      lanes: [],
      stdout: { write: () => {} },
      writeReport: async () => {},
    }),
    /selected no providers/,
  );
});
