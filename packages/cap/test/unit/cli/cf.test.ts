import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import { buildDeps, get, setTok } from "./_helpers";

describe("cf — header injection (Cloudflare API)", () => {
  it("api.cloudflare.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "cf", "api.cloudflare.com", "cf_v4_x");
    const out = await handleHttp(
      get("https://api.cloudflare.com/client/v4/zones"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer cf_v4_x");
  });

  it("strips legacy X-Auth-Key / X-Auth-Email global-API-key headers", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "cf", "api.cloudflare.com", "cf_real");
    const out = await handleHttp(
      get("https://api.cloudflare.com/client/v4/zones", {
        "X-Auth-Key": "leak_global_key",
        "X-Auth-Email": "user@example.com",
      }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const lower = Object.fromEntries(
      Object.entries(out.req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(lower["authorization"]).toBe("Bearer cf_real");
    expect(lower["x-auth-key"]).toBeUndefined();
    expect(lower["x-auth-email"]).toBeUndefined();
  });
});
