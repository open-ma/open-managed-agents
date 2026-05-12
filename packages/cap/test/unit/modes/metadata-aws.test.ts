import { describe, it, expect } from "vitest";
import { applyAwsMetadata } from "../../../src/modes/metadata-aws";
import { ManualClock } from "../../../src/test-fakes";
import type { CapSpec, HttpReqLike } from "../../../src/types";

const awsSpec: CapSpec = {
  cli_id: "aws",
  description: "AWS",
  endpoints: ["169.254.170.2"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "aws_container_credentials_v1",
    path: "/cap/aws-creds",
    required_request_headers: { Authorization: "match_bootstrap_token" },
  },
  bootstrap: {
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://${cap_host}:${cap_port}/cap/aws-creds",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "cap_bootstrap_secret",
    },
  },
};

const noValidationSpec: CapSpec = {
  ...awsSpec,
  cli_id: "aws-no-validation",
  metadata: { protocol: "aws_container_credentials_v1", path: "/cap/aws-creds" },
  bootstrap: undefined,
};

function get(headers: Record<string, string> = {}): HttpReqLike {
  return {
    url: "http://169.254.170.2/cap/aws-creds",
    method: "GET",
    headers,
    body: null,
  };
}

const clock = () => new ManualClock(Date.UTC(2026, 4, 9, 12, 0, 0)); // 2026-05-09T12:00:00Z

describe("applyAwsMetadata — happy path", () => {
  it("returns kind=respond status=200 with valid creds", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret_xyz",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0), // +1h
        extras: { access_key_id: "AKIATEST" },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    expect(out.kind).toBe("respond");
    if (out.kind !== "respond") return;
    expect(out.res.status).toBe(200);
    expect(out.res.headers["Content-Type"]).toBe("application/json");
  });

  it("body is the AWS Container Credentials JSON envelope", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret_xyz",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIATEST" },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    const body = JSON.parse(out.res.body);
    expect(body).toEqual({
      AccessKeyId: "AKIATEST",
      SecretAccessKey: "secret_xyz",
      Expiration: "2026-05-09T13:00:00.000Z",
    });
  });

  it("includes Token field when extras.session_token is supplied (STS-derived creds)", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret_xyz",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIATEST", session_token: "FQoDYXdz..." },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    const body = JSON.parse(out.res.body);
    expect(body.Token).toBe("FQoDYXdz...");
  });
});

describe("applyAwsMetadata — request validation (match_bootstrap_token)", () => {
  it("returns 401 when Authorization header is missing", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIATEST" },
      },
      get({}),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });

  it("returns 401 when Authorization doesn't match bootstrap token", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIATEST" },
      },
      get({ Authorization: "wrong_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });

  it("does NOT consult resolver when validation fails (resolver call is responsibility of orchestrator, but mode rejects pre-emit)", () => {
    // The mode itself receives a token already. The 401 path simply
    // returns without using it. Verifies we don't accidentally leak
    // `extras` or `token` content into the 401 body.
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret_should_not_leak",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIA_should_not_leak" },
      },
      get({ Authorization: "wrong" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.body).not.toContain("secret_should_not_leak");
    expect(out.res.body).not.toContain("AKIA_should_not_leak");
  });

  it("validates header name case-insensitively", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIA" },
      },
      get({ AUTHORIZATION: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
  });

  it("skips validation when spec has no required_request_headers", () => {
    const out = applyAwsMetadata(
      noValidationSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIA" },
      },
      get({}),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(200);
  });

  it("skips validation when match_bootstrap_token is referenced but bootstrap.env doesn't have the matching key (no-op safety; validation can't pass so request is rejected)", () => {
    const broken: CapSpec = {
      ...awsSpec,
      bootstrap: { env: {} }, // no AWS_CONTAINER_AUTHORIZATION_TOKEN
    };
    const out = applyAwsMetadata(
      broken,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        extras: { access_key_id: "AKIA" },
      },
      get({ Authorization: "anything" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });
});

describe("applyAwsMetadata — resolver-null and missing-fields", () => {
  it("returns 401 when token is null", () => {
    const out = applyAwsMetadata(
      awsSpec,
      null,
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(401);
  });

  it("returns 500 when extras.access_key_id is missing (resolver returned a malformed credential)", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
        // extras missing
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(500);
  });

  it("returns 500 when expires_at is missing (required for metadata_ep)", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        // expires_at missing
        extras: { access_key_id: "AKIA" },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    expect(out.res.status).toBe(500);
  });
});

describe("applyAwsMetadata — Expiration formatting", () => {
  it("Expiration is rendered as ISO8601 UTC", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2026, 4, 9, 12, 30, 45, 123),
        extras: { access_key_id: "AKIA" },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(),
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    const body = JSON.parse(out.res.body);
    expect(body.Expiration).toBe("2026-05-09T12:30:45.123Z");
  });

  it("Expiration uses the resolver-supplied expires_at, NOT clock.nowMs() (clock is only for relative timing modes like GCP)", () => {
    const out = applyAwsMetadata(
      awsSpec,
      {
        token: "secret",
        expires_at: Date.UTC(2027, 0, 1, 0, 0, 0),
        extras: { access_key_id: "AKIA" },
      },
      get({ Authorization: "cap_bootstrap_secret" }),
      clock(), // 2026-05-09 — should not appear anywhere
    );
    if (out.kind !== "respond") throw new Error("expected respond");
    const body = JSON.parse(out.res.body);
    expect(body.Expiration).toBe("2027-01-01T00:00:00.000Z");
  });
});
