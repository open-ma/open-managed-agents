import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("fly — header injection", () => {
  it("api.fly.io → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "fly", "api.fly.io", "fo1_xxx");
    const out = await handleHttp(get("https://api.fly.io/graphql"), { principal: "p1" }, deps);
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer fo1_xxx");
  });

  it("does not inject for unknown api.fly.io subdomains (single hostname spec, not wildcard)", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "fly", "machines.fly.io", "fo1_xxx");
    const out = await handleHttp(get("https://machines.fly.io/v1/apps"), { principal: "p1" }, deps);
    expect(out).toEqual({ kind: "passthrough" });
  });
});
