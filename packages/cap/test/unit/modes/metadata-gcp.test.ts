import { describe, it, expect } from "vitest";
import { applyGcpMetadata } from "../../../src/modes/metadata-gcp";
import { ManualClock } from "../../../src/test-fakes";
import type { CapSpec, HttpReqLike } from "../../../src/types";

const gcpSpec: CapSpec = {
  cli_id: "gcloud",
  description: "Google Cloud SDK metadata emulator",
  endpoints: ["metadata.google.internal"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "gcp_metadata_v1",
    path: "/computeMetadata/v1/instance/service-accounts/default/token",
    required_request_headers: { "Metadata-Flavor": "Google" },
  },
};

function get(headers: Record<string, string> = {}): HttpReqLike {
  return {
    url: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    method: "GET",
    headers,
    body: null,
  };
}

const NOW = Date.UTC(2026, 4, 9, 12, 0, 0); // 2026-05-09T12:00:00Z

describe("applyGcpMetadata — happy path", () => {
  it("returns 200 with the OAuth access_token envelope", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.gcp_token", expires_at: NOW + 3600_000 },
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    expect(out.kind).toBe("respond");
    if (out.kind !== "respond") return;
    expect(out.res.status).toBe(200);
    const body = JSON.parse(out.res.body);
    expect(body).toEqual({
      access_token: "ya29.gcp_token",
      expires_in: 3600,
      token_type: "Bearer",
    });
  });

  it("expires_in is integer seconds rounded down (computed from clock and expires_at)", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 1500 }, // 1.5s — should floor to 1
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    const body = JSON.parse(out.res.body);
    expect(body.expires_in).toBe(1);
  });

  it("response includes Metadata-Flavor: Google header (matches the real GCE metadata server)", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 3600_000 },
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.headers["Metadata-Flavor"]).toBe("Google");
  });

  it("Content-Type is application/json", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 3600_000 },
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.headers["Content-Type"]).toBe("application/json");
  });
});

describe("applyGcpMetadata — required Metadata-Flavor header", () => {
  it("returns 403 when Metadata-Flavor header is missing", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 3600_000 },
      get({}),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(403);
  });

  it("returns 403 when Metadata-Flavor has the wrong value", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 3600_000 },
      get({ "Metadata-Flavor": "AWS" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(403);
  });

  it("Metadata-Flavor header check is case-insensitive on header name", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW + 3600_000 },
      get({ "metadata-flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
  });
});

describe("applyGcpMetadata — null token and missing fields", () => {
  it("returns 401 when token is null", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      null,
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });

  it("returns 500 when expires_at is missing", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x" },
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(500);
  });

  it("returns 500 when expires_at is in the past (clock has passed it)", () => {
    const out = applyGcpMetadata(
      gcpSpec,
      { token: "ya29.x", expires_at: NOW - 1000 },
      get({ "Metadata-Flavor": "Google" }),
      new ManualClock(NOW),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    // Returning a negative or zero expires_in to a GCP SDK would race
    // forever — clearer to surface the resolver's stale credential as 500
    // and let the resolver re-resolve.
    expect(out.res.status).toBe(500);
  });
});
