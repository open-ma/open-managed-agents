import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import {
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
} from "../../../src/oauth";
import { azSpec } from "../../../src/builtin";
import { buildDeps, get, setTok } from "./_helpers";

describe("az — header injection (ARM)", () => {
  it("management.azure.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "az", "management.azure.com", "eyJtok_az");
    const out = await handleHttp(
      get("https://management.azure.com/subscriptions?api-version=2020-01-01"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer eyJtok_az");
  });
});

describe("az — OAuth device flow", () => {
  it("initiate hits login.microsoftonline.com devicecode endpoint with az client_id and ARM scope", () => {
    const req = buildDeviceInitiateRequest(azSpec);
    expect(req.url).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode",
    );
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("client_id")).toBe(
      "04b07795-8ddb-461a-bbee-02f9e1bf7b46",
    );
    expect(params.get("scope")).toBe(
      "https://management.azure.com/.default offline_access",
    );
  });

  it("poll hits the v2 token endpoint with the device-code grant_type", () => {
    const req = buildDevicePollRequest(azSpec, { device_code: "dc_az" });
    expect(req.url).toBe(
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    );
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    expect(params.get("device_code")).toBe("dc_az");
  });
});
