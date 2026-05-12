import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import {
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
} from "../../../src/oauth";
import { glabSpec } from "../../../src/builtin";
import { buildDeps, get, setTok } from "./_helpers";

describe("glab — header injection", () => {
  it("gitlab.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "glab", "gitlab.com", "tok_glab");
    const out = await handleHttp(get("https://gitlab.com/api/v4/user"), { principal: "p1" }, deps);
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_glab");
  });

  it("strips PRIVATE-TOKEN smuggle attempt", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "glab", "gitlab.com", "tok_real");
    const out = await handleHttp(
      get("https://gitlab.com/api/v4/user", { "PRIVATE-TOKEN": "evil_pat" }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const lowerKeys = Object.keys(out.req.headers).map((k) => k.toLowerCase());
    expect(lowerKeys).not.toContain("private-token");
  });
});

describe("glab — OAuth device flow", () => {
  it("initiate hits gitlab.com/oauth/authorize_device", () => {
    const req = buildDeviceInitiateRequest(glabSpec);
    expect(req.url).toBe("https://gitlab.com/oauth/authorize_device");
  });

  it("poll hits gitlab.com/oauth/token", () => {
    const req = buildDevicePollRequest(glabSpec, { device_code: "dc" });
    expect(req.url).toBe("https://gitlab.com/oauth/token");
  });
});
