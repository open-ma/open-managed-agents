import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("doctl — header injection", () => {
  it("api.digitalocean.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "doctl", "api.digitalocean.com", "dop_v1_x");
    const out = await handleHttp(
      get("https://api.digitalocean.com/v2/account"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer dop_v1_x");
  });
});
