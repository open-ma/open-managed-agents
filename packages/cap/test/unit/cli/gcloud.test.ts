import { describe, expect, it } from "vitest";
import { handleHttp } from "../../../src/handle-http";
import {
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
} from "../../../src/oauth";
import { gcloudSpec } from "../../../src/builtin";
import { buildDeps, get, setTok, NOW_MS } from "./_helpers";

describe("gcloud — GCE metadata server emulation", () => {
  it("returns OAuth access_token JSON envelope when authenticated", async () => {
    const deps = buildDeps();
    setTok(
      deps.resolver,
      "gcloud",
      "metadata.google.internal",
      "ya29.gcp_token",
      undefined,
      NOW_MS + 3600_000,
    );
    const out = await handleHttp(
      get(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { "Metadata-Flavor": "Google" },
      ),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
    expect(out.res.headers["Metadata-Flavor"]).toBe("Google");
    const body = JSON.parse(out.res.body);
    expect(body).toEqual({
      access_token: "ya29.gcp_token",
      expires_in: 3600,
      token_type: "Bearer",
    });
  });

  it("returns 403 when Metadata-Flavor is missing (matches real GCE behaviour)", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "gcloud", "metadata.google.internal", "ya29.x", undefined, NOW_MS + 3600_000);
    const out = await handleHttp(
      get(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      ),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(403);
  });

  it("169.254.169.254 also routes to gcloud (IP-based metadata server)", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "gcloud", "169.254.169.254", "ya29.x", undefined, NOW_MS + 3600_000);
    const out = await handleHttp(
      get(
        "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
        { "Metadata-Flavor": "Google" },
      ),
      { principal: "p1" },
      deps,
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
  });
});

describe("gcloud — OAuth device flow", () => {
  it("initiate hits oauth2.googleapis.com/device/code", () => {
    const req = buildDeviceInitiateRequest(gcloudSpec);
    expect(req.url).toBe("https://oauth2.googleapis.com/device/code");
  });

  it("poll hits oauth2.googleapis.com/token", () => {
    const req = buildDevicePollRequest(gcloudSpec, { device_code: "dc" });
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
  });
});
