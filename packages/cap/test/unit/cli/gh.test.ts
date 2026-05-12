import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import {
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
  parseDeviceInitiateResponse,
  parseDevicePollResponse,
} from "../../../src/oauth";
import { ghSpec } from "../../../src/builtin";
import { buildDeps, get, setTok, NOW_MS } from "./_helpers";

describe("gh — header injection", () => {
  it("api.github.com → Authorization: Bearer <token>", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "gh", "api.github.com", "tok_gh");
    const out = await handleHttp(get("https://api.github.com/user"), { principal: "p1" }, deps);
    expect(out.kind).toBe("forward");
    if (out.kind !== "forward") return;
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_gh");
  });

  it("uploads.github.com routes to the same gh spec", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "gh", "uploads.github.com", "tok_gh_upload");
    const out = await handleHttp(
      get("https://uploads.github.com/repos/o/r/releases/1/assets"),
      { principal: "p1" },
      deps,
    );
    expect(out.kind).toBe("forward");
    if (out.kind !== "forward") return;
    expect(out.req.headers["Authorization"]).toBe("Bearer tok_gh_upload");
  });

  it("strips an attempted Authorization smuggle from the inbound request", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "gh", "api.github.com", "tok_real");
    const out = await handleHttp(
      get("https://api.github.com/user", { Authorization: "Bearer tok_smuggled" }),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    const values = Object.entries(out.req.headers)
      .filter(([k]) => k.toLowerCase() === "authorization")
      .map(([, v]) => v);
    expect(values).toEqual(["Bearer tok_real"]);
  });
});

describe("gh — OAuth device flow", () => {
  it("buildDeviceInitiateRequest hits github.com/login/device/code with Accept: application/json", () => {
    const req = buildDeviceInitiateRequest(ghSpec);
    expect(req.url).toBe("https://github.com/login/device/code");
    expect(req.headers["Accept"]).toBe("application/json");
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("client_id")).toBe("178c6fc778ccc68e1d6a");
    expect(params.get("scope")).toBe("repo read:org gist workflow");
  });

  it("end-to-end device flow → resolver.store called with the access_token", async () => {
    const deps = buildDeps();

    // Step 1: initiate (test stubs the http response)
    const initResHeaders = { "Content-Type": "application/json" };
    const initBody = JSON.stringify({
      device_code: "dev_xyz",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    const state = parseDeviceInitiateResponse(
      ghSpec,
      { status: 200, headers: initResHeaders, body: initBody },
      deps.clock,
    );
    expect(state.user_code).toBe("WDJB-MJHT");

    // Step 2: poll once → pending
    const pendingRes = parseDevicePollResponse(
      ghSpec,
      { status: 400, headers: initResHeaders, body: JSON.stringify({ error: "authorization_pending" }) },
      deps.clock,
      state,
    );
    expect(pendingRes.kind).toBe("pending");

    // Step 3: poll again → ready
    const readyRes = parseDevicePollResponse(
      ghSpec,
      {
        status: 200,
        headers: initResHeaders,
        body: JSON.stringify({
          access_token: "ghu_acquired",
          token_type: "Bearer",
          expires_in: 28800,
          refresh_token: "ghr_refresh",
        }),
      },
      deps.clock,
      state,
    );
    expect(readyRes.kind).toBe("ready");
    if (readyRes.kind !== "ready") return;

    // Step 4: L4 driver writes back to vault via resolver.store
    await deps.resolver.store(
      { principal: "p1", cli_id: "gh", hostname: "api.github.com" },
      readyRes.token,
    );

    // Verify resolver records the store call with the freshly minted token.
    const storeCall = deps.resolver.calls.find((c) => c.op === "store");
    expect(storeCall).toBeDefined();
    expect(storeCall!.token!.token).toBe("ghu_acquired");
    expect(storeCall!.token!.extras?.refresh_token).toBe("ghr_refresh");

    // Step 5: subsequent injection uses the stored token.
    const out = await handleHttp(
      get("https://api.github.com/user"),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "forward") throw new Error("expected forward");
    expect(out.req.headers["Authorization"]).toBe("Bearer ghu_acquired");
  });

  it("buildDevicePollRequest uses the device-code grant_type and the stored device_code", () => {
    const state = {
      device_code: "dev_xyz",
      user_code: "X",
      verification_uri: "https://x",
      interval_seconds: 5,
      expires_at_ms: NOW_MS + 900_000,
    };
    const req = buildDevicePollRequest(ghSpec, state);
    expect(req.url).toBe("https://github.com/login/oauth/access_token");
    const params = new URLSearchParams(new TextDecoder().decode(req.body!));
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(params.get("device_code")).toBe("dev_xyz");
  });
});
