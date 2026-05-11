import { describe, it, expect } from "vitest";
import { createSpecRegistry } from "../../src/registry";
import type { CapSpec } from "../../src/types";

const ghSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI",
  endpoints: ["api.github.com", "uploads.github.com"],
  inject_mode: "header",
  header: { strip: ["authorization"], set: { name: "Authorization", value: "Bearer ${token}" } },
};

const awsSpec: CapSpec = {
  cli_id: "aws",
  description: "AWS CLI / SDKs",
  endpoints: ["*.amazonaws.com"],
  inject_mode: "metadata_ep",
  metadata: { protocol: "aws_container_credentials_v1", path: "/cap/aws-creds" },
};

// Hypothetical "internal s3 mirror" spec that uses a more specific exact
// match overlapping the AWS wildcard. Used to verify exact-wins semantics.
const internalS3Spec: CapSpec = {
  cli_id: "internal-s3",
  description: "Internal S3-compatible mirror — exact match overrides aws's wildcard",
  endpoints: ["s3.amazonaws.com"],
  inject_mode: "header",
  header: { strip: ["authorization"], set: { name: "Authorization", value: "Bearer ${token}" } },
};

describe("SpecRegistry — empty", () => {
  it("byCliId returns null on empty registry", () => {
    const r = createSpecRegistry([]);
    expect(r.byCliId("gh")).toBeNull();
  });

  it("byHostname returns null on empty registry", () => {
    const r = createSpecRegistry([]);
    expect(r.byHostname("api.github.com")).toBeNull();
  });

  it("all() returns empty array", () => {
    const r = createSpecRegistry([]);
    expect(r.all()).toEqual([]);
  });
});

describe("SpecRegistry — byCliId", () => {
  const r = createSpecRegistry([ghSpec, awsSpec]);

  it("returns the spec for a registered cli_id", () => {
    expect(r.byCliId("gh")).toBe(ghSpec);
  });

  it("returns null for an unknown cli_id", () => {
    expect(r.byCliId("nope")).toBeNull();
  });

  it("is case-sensitive on cli_id (cli_ids are stable lowercase by convention)", () => {
    expect(r.byCliId("GH")).toBeNull();
  });
});

describe("SpecRegistry — byHostname", () => {
  it("returns spec for an exact hostname match", () => {
    const r = createSpecRegistry([ghSpec]);
    expect(r.byHostname("api.github.com")).toBe(ghSpec);
  });

  it("returns spec for a wildcard hostname match", () => {
    const r = createSpecRegistry([awsSpec]);
    expect(r.byHostname("s3.us-east-1.amazonaws.com")).toBe(awsSpec);
  });

  it("returns null when no spec matches", () => {
    const r = createSpecRegistry([ghSpec]);
    expect(r.byHostname("evil.com")).toBeNull();
  });

  it("hostname match is case-insensitive on the host", () => {
    const r = createSpecRegistry([ghSpec]);
    expect(r.byHostname("API.GitHub.com")).toBe(ghSpec);
  });

  it("exact match wins over wildcard match", () => {
    // s3.amazonaws.com is matched by both "s3.amazonaws.com" (exact, internalS3)
    // and "*.amazonaws.com" (wildcard, aws). Exact must win.
    const r = createSpecRegistry([awsSpec, internalS3Spec]);
    expect(r.byHostname("s3.amazonaws.com")).toBe(internalS3Spec);
  });

  it("exact match wins over wildcard regardless of registration order", () => {
    const r = createSpecRegistry([internalS3Spec, awsSpec]);
    expect(r.byHostname("s3.amazonaws.com")).toBe(internalS3Spec);
  });

  it("wildcard still matches sibling hosts the exact spec doesn't cover", () => {
    const r = createSpecRegistry([awsSpec, internalS3Spec]);
    expect(r.byHostname("ec2.amazonaws.com")).toBe(awsSpec);
  });
});

describe("SpecRegistry — all()", () => {
  it("returns specs in insertion order", () => {
    const r = createSpecRegistry([awsSpec, ghSpec]);
    expect(r.all().map((s) => s.cli_id)).toEqual(["aws", "gh"]);
  });
});

describe("SpecRegistry — construction validation", () => {
  it("rejects duplicate cli_ids", () => {
    const dup: CapSpec = { ...ghSpec, endpoints: ["other.example.com"] };
    expect(() => createSpecRegistry([ghSpec, dup])).toThrow(/duplicate.*gh/);
  });

  it("rejects an invalid hostname pattern in any spec at construction time", () => {
    const bad: CapSpec = { ...ghSpec, cli_id: "bad", endpoints: ["*.com"] };
    expect(() => createSpecRegistry([bad])).toThrow();
  });

  it("rejects a spec missing the mode-specific sub-object", () => {
    const broken: CapSpec = {
      cli_id: "broken",
      description: "missing header sub-object",
      endpoints: ["broken.example.com"],
      inject_mode: "header",
      // header: undefined
    };
    expect(() => createSpecRegistry([broken])).toThrow(/header/i);
  });

  it("rejects a metadata_ep spec missing metadata sub-object", () => {
    const broken: CapSpec = {
      cli_id: "broken-meta",
      description: "missing metadata",
      endpoints: ["broken.example.com"],
      inject_mode: "metadata_ep",
    };
    expect(() => createSpecRegistry([broken])).toThrow(/metadata/i);
  });

  it("rejects an exec_helper spec missing exec sub-object", () => {
    const broken: CapSpec = {
      cli_id: "broken-exec",
      description: "missing exec",
      endpoints: ["broken.example.com"],
      inject_mode: "exec_helper",
    };
    expect(() => createSpecRegistry([broken])).toThrow(/exec/i);
  });

  it("rejects an empty endpoints array", () => {
    const broken: CapSpec = { ...ghSpec, cli_id: "empty", endpoints: [] };
    expect(() => createSpecRegistry([broken])).toThrow(/empty endpoints/);
  });

  // ─── OAuth validation ─────────────────────────────────────────────────
  it("rejects oauth missing initiate_url", () => {
    const broken: CapSpec = {
      ...ghSpec,
      cli_id: "broken-oauth",
      oauth: {
        device_flow: {
          initiate_url: "",
          token_url: "https://x/token",
          client_id: "c",
          scopes: [],
        },
      },
    };
    expect(() => createSpecRegistry([broken])).toThrow(/initiate_url/);
  });

  it("rejects oauth missing token_url", () => {
    const broken: CapSpec = {
      ...ghSpec,
      cli_id: "broken-oauth",
      oauth: {
        device_flow: {
          initiate_url: "https://x/init",
          token_url: "",
          client_id: "c",
          scopes: [],
        },
      },
    };
    expect(() => createSpecRegistry([broken])).toThrow(/token_url/);
  });

  it("rejects oauth missing client_id", () => {
    const broken: CapSpec = {
      ...ghSpec,
      cli_id: "broken-oauth",
      oauth: {
        device_flow: {
          initiate_url: "https://x/init",
          token_url: "https://x/token",
          client_id: "",
          scopes: [],
        },
      },
    };
    expect(() => createSpecRegistry([broken])).toThrow(/client_id/);
  });

  it("rejects oauth.device_flow.scopes when not an array", () => {
    const broken = {
      ...ghSpec,
      cli_id: "broken-oauth",
      oauth: {
        device_flow: {
          initiate_url: "https://x/init",
          token_url: "https://x/token",
          client_id: "c",
          scopes: "not-an-array" as unknown as readonly string[],
        },
      },
    };
    expect(() => createSpecRegistry([broken])).toThrow(/scopes/);
  });
});
