import { describe, it, expect } from "vitest";
import {
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
  parseDeviceInitiateResponse,
  parseDevicePollResponse,
} from "../../src/oauth";
import { ManualClock } from "../../src/test-fakes";
import type { CapSpec, HttpResLike } from "../../src/types";

const ghOauthSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI",
  endpoints: ["api.github.com"],
  inject_mode: "header",
  header: { strip: ["authorization"], set: { name: "Authorization", value: "Bearer ${token}" } },
  oauth: {
    device_flow: {
      initiate_url: "https://github.com/login/device/code",
      token_url: "https://github.com/login/oauth/access_token",
      client_id: "Iv1.cap123",
      scopes: ["repo", "read:user"],
      request_headers: { Accept: "application/json" },
    },
  },
};

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0);

function res(status: number, body: unknown): HttpResLike {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

// ─── buildDeviceInitiateRequest ────────────────────────────────────────────

describe("buildDeviceInitiateRequest", () => {
  it("returns a POST to spec.oauth.device_flow.initiate_url", () => {
    const req = buildDeviceInitiateRequest(ghOauthSpec);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://github.com/login/device/code");
  });

  it("sets Content-Type to application/x-www-form-urlencoded", () => {
    const req = buildDeviceInitiateRequest(ghOauthSpec);
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("body is form-encoded with client_id and scope (space-joined)", () => {
    const req = buildDeviceInitiateRequest(ghOauthSpec);
    expect(req.body).not.toBeNull();
    const text = new TextDecoder().decode(req.body!);
    const params = new URLSearchParams(text);
    expect(params.get("client_id")).toBe("Iv1.cap123");
    expect(params.get("scope")).toBe("repo read:user");
  });

  it("merges spec.oauth.device_flow.request_headers (e.g. Accept: application/json)", () => {
    const req = buildDeviceInitiateRequest(ghOauthSpec);
    expect(req.headers["Accept"]).toBe("application/json");
  });

  it("throws when spec has no oauth field", () => {
    const noOauth: CapSpec = { ...ghOauthSpec, oauth: undefined };
    expect(() => buildDeviceInitiateRequest(noOauth)).toThrow(/oauth/);
  });

  it("omits scope param when scopes array is empty", () => {
    const noScope: CapSpec = {
      ...ghOauthSpec,
      oauth: { device_flow: { ...ghOauthSpec.oauth!.device_flow, scopes: [] } },
    };
    const req = buildDeviceInitiateRequest(noScope);
    const text = new TextDecoder().decode(req.body!);
    const params = new URLSearchParams(text);
    expect(params.has("scope")).toBe(false);
  });
});

// ─── parseDeviceInitiateResponse ──────────────────────────────────────────

describe("parseDeviceInitiateResponse — happy path", () => {
  it("parses RFC 8628 fields into DeviceFlowState", () => {
    const state = parseDeviceInitiateResponse(
      ghOauthSpec,
      res(200, {
        device_code: "dev_abc",
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=WDJB-MJHT",
        expires_in: 1800,
        interval: 5,
      }),
      new ManualClock(NOW),
    );
    expect(state.device_code).toBe("dev_abc");
    expect(state.user_code).toBe("WDJB-MJHT");
    expect(state.verification_uri).toBe("https://github.com/login/device");
    expect(state.verification_uri_complete).toBe(
      "https://github.com/login/device?user_code=WDJB-MJHT",
    );
    expect(state.interval_seconds).toBe(5);
    expect(state.expires_at_ms).toBe(NOW + 1_800_000);
  });

  it("verification_uri_complete is undefined when upstream omits it", () => {
    const state = parseDeviceInitiateResponse(
      ghOauthSpec,
      res(200, {
        device_code: "x",
        user_code: "X",
        verification_uri: "https://example.com/d",
        expires_in: 600,
        interval: 5,
      }),
      new ManualClock(NOW),
    );
    expect(state.verification_uri_complete).toBeUndefined();
  });

  it("defaults interval to 5s when upstream omits it (RFC 8628 § 3.5)", () => {
    const state = parseDeviceInitiateResponse(
      ghOauthSpec,
      res(200, {
        device_code: "x",
        user_code: "X",
        verification_uri: "https://example.com/d",
        expires_in: 600,
      }),
      new ManualClock(NOW),
    );
    expect(state.interval_seconds).toBe(5);
  });
});

describe("parseDeviceInitiateResponse — error paths", () => {
  it("throws on non-200 status", () => {
    expect(() =>
      parseDeviceInitiateResponse(
        ghOauthSpec,
        res(401, { error: "invalid_client" }),
        new ManualClock(NOW),
      ),
    ).toThrow(/initiate.*401/i);
  });

  it("throws when JSON is missing required fields (device_code)", () => {
    expect(() =>
      parseDeviceInitiateResponse(
        ghOauthSpec,
        res(200, { user_code: "X", verification_uri: "https://x", expires_in: 600 }),
        new ManualClock(NOW),
      ),
    ).toThrow(/device_code/);
  });

  it("throws on malformed JSON body", () => {
    expect(() =>
      parseDeviceInitiateResponse(
        ghOauthSpec,
        { status: 200, headers: {}, body: "not json {" },
        new ManualClock(NOW),
      ),
    ).toThrow();
  });
});

// ─── buildDevicePollRequest ────────────────────────────────────────────────

describe("buildDevicePollRequest", () => {
  const state = {
    device_code: "dev_abc",
    user_code: "WDJB-MJHT",
    verification_uri: "https://x",
    interval_seconds: 5,
    expires_at_ms: NOW + 1_800_000,
  };

  it("POST to spec.oauth.device_flow.token_url", () => {
    const req = buildDevicePollRequest(ghOauthSpec, state);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://github.com/login/oauth/access_token");
  });

  it("body has device_code, client_id, and grant_type=urn:ietf:params:oauth:grant-type:device_code", () => {
    const req = buildDevicePollRequest(ghOauthSpec, state);
    const text = new TextDecoder().decode(req.body!);
    const params = new URLSearchParams(text);
    expect(params.get("device_code")).toBe("dev_abc");
    expect(params.get("client_id")).toBe("Iv1.cap123");
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  });

  it("merges spec.oauth.device_flow.request_headers", () => {
    const req = buildDevicePollRequest(ghOauthSpec, state);
    expect(req.headers["Accept"]).toBe("application/json");
  });
});

// ─── parseDevicePollResponse ──────────────────────────────────────────────

describe("parseDevicePollResponse — success", () => {
  it("kind=ready with ResolvedToken built from access_token + expires_in", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(200, {
        access_token: "ghu_xxx",
        token_type: "Bearer",
        expires_in: 28800,
      }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("ready");
    if (r.kind !== "ready") return;
    expect(r.token.token).toBe("ghu_xxx");
    expect(r.token.expires_at).toBe(NOW + 28_800_000);
  });

  it("preserves refresh_token + token_type in extras when present", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(200, {
        access_token: "ghu_x",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "ghr_x",
      }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    if (r.kind !== "ready") throw new Error("expected ready");
    expect(r.token.extras?.refresh_token).toBe("ghr_x");
    expect(r.token.extras?.token_type).toBe("Bearer");
  });

  it("expires_at undefined when upstream omits expires_in (token doesn't expire — uncommon)", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(200, { access_token: "x", token_type: "Bearer" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    if (r.kind !== "ready") throw new Error("expected ready");
    expect(r.token.expires_at).toBeUndefined();
  });
});

describe("parseDevicePollResponse — pending / slow_down", () => {
  it("kind=pending on error=authorization_pending", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(400, { error: "authorization_pending" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("pending");
  });

  it("kind=slow_down on error=slow_down (interval bumped by 5s per RFC 8628 § 3.5)", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(400, { error: "slow_down" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("slow_down");
    if (r.kind !== "slow_down") return;
    expect(r.new_interval_seconds).toBe(10);
  });
});

describe("parseDevicePollResponse — terminal error states", () => {
  it("kind=expired on error=expired_token", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(400, { error: "expired_token" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("expired");
  });

  it("kind=denied on error=access_denied", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(400, { error: "access_denied" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("denied");
  });

  it("kind=error on unrecognized OAuth error code, preserving the code", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(400, { error: "invalid_grant", error_description: "no such device_code" }),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.oauth_error).toBe("invalid_grant");
    expect(r.description).toBe("no such device_code");
  });

  it("kind=error on 5xx with no OAuth error code", () => {
    const r = parseDevicePollResponse(
      ghOauthSpec,
      res(503, "Service Unavailable"),
      new ManualClock(NOW),
      { interval_seconds: 5 },
    );
    expect(r.kind).toBe("error");
  });
});
