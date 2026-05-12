import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("heroku — header injection", () => {
  it("api.heroku.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "heroku", "api.heroku.com", "hk_xxx");
    const out = await handleHttp(
      get("https://api.heroku.com/account"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer hk_xxx");
  });
});
