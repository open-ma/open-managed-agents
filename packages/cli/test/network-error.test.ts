import { describe, expect, it } from "vitest";
import { withNetworkCause } from "../src/network-error.js";

describe("withNetworkCause", () => {
  it("includes the underlying network error code", () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const error = new TypeError("fetch failed", { cause });

    expect(withNetworkCause(error).message).toBe("fetch failed (ECONNRESET)");
  });
});
