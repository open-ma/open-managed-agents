import { describe, expect, it } from "vitest";

import { CfManagedSessionSecretSealer } from "../src/lib/cf-managed-session-secret-sealer";

describe("Cloudflare managed Session resource secret codec", () => {
  it("opens values sealed by the same control-plane key", async () => {
    const codec = new CfManagedSessionSecretSealer("test-root-secret");
    const sealed = await codec.seal("github-token");

    await expect(codec.open(sealed)).resolves.toBe("github-token");
  });
});
