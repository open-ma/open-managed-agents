import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("npm — header injection", () => {
  it("registry.npmjs.org → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "npm", "registry.npmjs.org", "npm_xyz");
    const out = await handleHttp(
      get("https://registry.npmjs.org/-/whoami"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer npm_xyz");
  });
});
