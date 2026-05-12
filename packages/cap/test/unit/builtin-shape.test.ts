import { describe, expect, it } from "vitest";
import { builtinSpecs } from "../../src/builtin";
import { createSpecRegistry } from "../../src/registry";
import type { CapSpec } from "../../src/types";

describe("builtinSpecs — registry-construction round-trip", () => {
  it("constructs a SpecRegistry without throwing (validates every endpoint pattern, mode sub-object, and oauth shape)", () => {
    expect(() => createSpecRegistry(builtinSpecs)).not.toThrow();
  });

  it("has no duplicate cli_ids", () => {
    const ids = builtinSpecs.map((s) => s.cli_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has at least one spec for each inject_mode", () => {
    const modes = new Set(builtinSpecs.map((s) => s.inject_mode));
    expect(modes.has("header")).toBe(true);
    expect(modes.has("metadata_ep")).toBe(true);
    expect(modes.has("exec_helper")).toBe(true);
  });
});

describe("builtinSpecs — header_inject mode invariants", () => {
  const headerSpecs = builtinSpecs.filter((s) => s.inject_mode === "header");

  it.each(headerSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: header.set.value contains ${token} placeholder",
    (_id, spec) => {
      expect(spec.header).toBeDefined();
      expect(spec.header!.set.value).toContain("${token}");
    },
  );

  it.each(headerSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: header.strip includes the header it sets (prevents the rewritten request from carrying both)",
    (_id, spec) => {
      const lowerStripped = spec.header!.strip.map((h) => h.toLowerCase());
      expect(lowerStripped).toContain(spec.header!.set.name.toLowerCase());
    },
  );
});

describe("builtinSpecs — metadata_ep mode invariants", () => {
  const metaSpecs = builtinSpecs.filter((s) => s.inject_mode === "metadata_ep");

  it.each(metaSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: metadata.protocol is a known protocol",
    (_id, spec) => {
      expect(["aws_container_credentials_v1", "gcp_metadata_v1"]).toContain(
        spec.metadata!.protocol,
      );
    },
  );

  it.each(metaSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: declares an endpoint_binding env_var so L4 can wire the SDK to our metadata server",
    (_id, spec) => {
      expect(spec.endpoint_binding).toBeDefined();
      expect(spec.endpoint_binding!.env_var.length).toBeGreaterThan(0);
      expect(spec.endpoint_binding!.value_template).toContain("${cap_host}");
    },
  );
});

describe("builtinSpecs — exec_helper mode invariants", () => {
  const execSpecs = builtinSpecs.filter((s) => s.inject_mode === "exec_helper");

  it.each(execSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: exec.protocol is a known protocol",
    (_id, spec) => {
      expect([
        "kubectl_exec_credential_v1",
        "docker_credential_helper",
        "git_credential_helper",
      ]).toContain(spec.exec!.protocol);
    },
  );
});

describe("builtinSpecs — bootstrap sentinel discipline", () => {
  function bootstrapEnvValues(spec: CapSpec): string[] {
    return Object.values(spec.bootstrap?.env ?? {});
  }

  // A bootstrap value should be a sentinel like "__cap_managed__" or a
  // template URL (for endpoint_binding bootstraps). Never a real-looking
  // credential pattern (e.g. starts with "sk_", "ghp_", "Iv1.", etc).
  // Misconfiguration here would leak a placeholder that looks credential-
  // shaped to anyone reading the spec.
  it.each(builtinSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: bootstrap.env values are sentinels, templates, or hostnames — never credential-shaped",
    (_id, spec) => {
      const dangerous = /^(sk_|ghp_|gho_|ghu_|ghr_|github_pat_|fo1_|npm_|AKIA|ASIA|xoxb-)/;
      for (const v of bootstrapEnvValues(spec)) {
        expect(v).not.toMatch(dangerous);
      }
    },
  );
});

describe("builtinSpecs — OAuth device flow invariants (where present)", () => {
  const oauthSpecs = builtinSpecs.filter((s) => s.oauth?.device_flow);

  it("has OAuth device flow specs for at least gh, glab, gcloud", () => {
    const ids = oauthSpecs.map((s) => s.cli_id);
    expect(ids).toContain("gh");
    expect(ids).toContain("glab");
    expect(ids).toContain("gcloud");
  });

  it.each(oauthSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: oauth.device_flow.initiate_url and token_url are absolute https URLs",
    (_id, spec) => {
      const df = spec.oauth!.device_flow;
      expect(df.initiate_url).toMatch(/^https:\/\//);
      expect(df.token_url).toMatch(/^https:\/\//);
    },
  );

  it.each(oauthSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: oauth.device_flow.client_id is non-empty",
    (_id, spec) => {
      expect(spec.oauth!.device_flow.client_id.length).toBeGreaterThan(0);
    },
  );

  it.each(oauthSpecs.map((s) => [s.cli_id, s] as const))(
    "%s: oauth.device_flow.scopes is an array (may be empty)",
    (_id, spec) => {
      expect(Array.isArray(spec.oauth!.device_flow.scopes)).toBe(true);
    },
  );
});

describe("builtinSpecs — coverage", () => {
  it("includes the canonical 11-CLI first-wave set", () => {
    const ids = new Set(builtinSpecs.map((s) => s.cli_id));
    for (const expected of [
      "gh", "glab", "fly", "vercel", "doctl", "npm",
      "aws", "gcloud", "kubectl", "docker", "git",
    ]) {
      expect(ids).toContain(expected);
    }
  });
});
