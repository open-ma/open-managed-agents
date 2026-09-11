import { describe, expect, it, vi } from "vitest";

import { prepareSandboxEgress } from "../../apps/agent/src/runtime/sandbox-warmup-egress";

describe("sandbox warmup egress prelude", () => {
  it("binds the session egress context before network-dependent warmup work", async () => {
    const calls: string[] = [];
    const setOutboundContext = vi.fn(async () => {
      calls.push("egress");
    });

    await prepareSandboxEgress({ setOutboundContext }, {
      tenantId: "tenant-1",
      sessionId: "session-1",
    });
    calls.push("git-clone");

    expect(calls).toEqual(["egress", "git-clone"]);
    expect(setOutboundContext).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      sessionId: "session-1",
    });
  });

  it("does not require an egress hook from runtimes with native networking", async () => {
    await expect(prepareSandboxEgress({}, {
      tenantId: "tenant-1",
      sessionId: "session-1",
    })).resolves.toBeUndefined();
  });
});
