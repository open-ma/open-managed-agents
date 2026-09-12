import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";

const OWNED_PREFIXES = ["oma-", "openma-"] as const;

// Process-level route tests need a deterministic sandbox without booting a VM
// in the generic unit-test lane. The production selector never exposes this
// adapter; live provider certification owns LiteBox and the other runtimes.
process.env.OPENMA_TEST_SANDBOX_PROVIDER ??= "local-subprocess";

async function ownedEntries(): Promise<Set<string>> {
  return new Set(
    (await readdir(tmpdir()))
      .filter((name) => OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))),
  );
}

const baseline = await ownedEntries();

afterAll(async () => {
  const leaked = [...await ownedEntries()]
    .filter((name) => !baseline.has(name))
    .sort();
  if (leaked.length > 0) {
    throw new Error(`main-node test leaked temporary resources: ${leaked.join(", ")}`);
  }
});
