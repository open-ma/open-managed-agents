import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("vercel — header injection", () => {
  it("api.vercel.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "vercel", "api.vercel.com", "tok_v");
    const out = await handleHttp(
      get("https://api.vercel.com/v9/projects"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_v");
  });
});
