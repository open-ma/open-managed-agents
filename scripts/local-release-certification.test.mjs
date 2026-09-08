import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildLocalReleaseEnvironment,
  buildLocalReleasePlan,
} from "./local-release-certification.mjs";

test("local release environment isolates durable state and serves the built console", () => {
  const root = resolve("/tmp/openma-local-release-fixture");
  const environment = buildLocalReleaseEnvironment(
    { PATH: "/usr/bin", SHOULD_SURVIVE: "yes" },
    {
      root,
      port: 19433,
      llmBaseUrl: "http://127.0.0.1:19434/",
      apiKey: "fixture-api-key",
      repoRoot: "/repo",
    },
  );

  assert.equal(environment.SHOULD_SURVIVE, "yes");
  assert.equal(environment.PORT, "19433");
  assert.equal(environment.AUTH_DISABLED, "1");
  assert.equal(environment.SANDBOX_PROVIDER, "subprocess");
  assert.equal(environment.ANTHROPIC_BASE_URL, "http://127.0.0.1:19434");
  assert.equal(environment.CONSOLE_DIR, "/repo/apps/console/dist");
  assert.equal(environment.DATABASE_PATH, join(root, "oma.db"));
  assert.equal(environment.SANDBOX_WORKDIR, join(root, "sandboxes"));
  assert.equal(environment.API_KEY, "fixture-api-key");
  assert.equal(
    environment.PLATFORM_ROOT_SECRET,
    "openma-local-release-root-secret-32-bytes-minimum",
  );
});

test("local release plan covers every public interface with real product processes", () => {
  assert.deepEqual(buildLocalReleasePlan(), [
    { id: "console-build", interface: "console" },
    { id: "main-node-start", interface: "node" },
    { id: "managed-agents-sdk", interface: "sdk" },
    { id: "managed-inputs-mcp", interface: "sdk+sandbox+mcp" },
    { id: "cli-projection", interface: "cli" },
    { id: "console-browser", interface: "console" },
  ]);
});
