import { describe, it, expect } from "vitest";
import { handleHttp } from "../../src/handle-http";
import { createSpecRegistry } from "../../src/registry";
import { FakeResolver, ManualClock, SilentLogger } from "../../src/test-fakes";
import { ResolverError } from "../../src/errors";
import type { CapSpec, HttpReqLike } from "../../src/types";

const ghSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI",
  endpoints: ["api.github.com"],
  inject_mode: "header",
  header: {
    strip: ["authorization"],
    set: { name: "Authorization", value: "Bearer ${token}" },
  },
};

const awsSpec: CapSpec = {
  cli_id: "aws",
  description: "AWS",
  endpoints: ["*.amazonaws.com"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "aws_container_credentials_v1",
    path: "/cap/aws-creds",
    required_request_headers: { Authorization: "match_bootstrap_token" },
  },
  bootstrap: {
    env: { AWS_CONTAINER_AUTHORIZATION_TOKEN: "boot_secret" },
  },
};

const gcpSpec: CapSpec = {
  cli_id: "gcloud",
  description: "GCP",
  endpoints: ["metadata.google.internal"],
  inject_mode: "metadata_ep",
  metadata: {
    protocol: "gcp_metadata_v1",
    path: "/computeMetadata/v1/instance/service-accounts/default/token",
    required_request_headers: { "Metadata-Flavor": "Google" },
  },
};// exec_helper specs are not reachable through handleHttp — handleExec is
// the entry point. Including one in the registry verifies that the
// orchestrator routes to passthrough rather than crashing on an unhandled
// inject_mode if the spec is somehow looked up via hostname.
const kubectlSpec: CapSpec = {
  cli_id: "kubectl",
  description: "kubectl exec helper",
  endpoints: ["never-reached.example.com"],
  inject_mode: "exec_helper",
  exec: { protocol: "kubectl_exec_credential_v1" },
};

function req(url: string, headers: Record<string, string> = {}): HttpReqLike {
  return { url, method: "GET", headers, body: null };
}

const baseDeps = () => ({
  resolver: new FakeResolver(),
  registry: createSpecRegistry([ghSpec, awsSpec, gcpSpec, kubectlSpec]),
  clock: new ManualClock(0),
  logger: new SilentLogger(),
});

const ctx = { principal: "p1" };

describe("handleHttp — routing", () => {
  it("passthrough when no spec matches the request hostname", async () => {
    const deps = baseDeps();
    const res = await handleHttp(req("https://evil.example.com/foo"), ctx, deps);
    expect(res).toEqual({ kind: "passthrough" });
    // No resolver call should have happened.
    expect(deps.resolver.calls).toHaveLength(0);
  });

  it("routes to header mode when spec.inject_mode === 'header'", async () => {
    const deps = baseDeps();
    deps.resolver.set({ principal: "p1", cli_id: "gh", hostname: "api.github.com" }, {
      token: "tok_gh",
    });
    const res = await handleHttp(req("https://api.github.com/user"), ctx, deps);
    expect(res.kind).toBe("forward");
    if (res.kind !== "forward") return;
    expect(res.req.headers["Authorization"]).toBe("Bearer tok_gh");
    expect(res.req.url).toBe("https://api.github.com/user");
  });

  it("routes to metadata-aws mode for aws_container_credentials_v1 protocol", async () => {
    const deps = baseDeps();
    deps.resolver.set({ principal: "p1", cli_id: "aws", hostname: "s3.amazonaws.com" }, {
      token: "secret_xyz",
      expires_at: Date.UTC(2026, 4, 9, 13, 0, 0),
      extras: { access_key_id: "AKIATEST" },
    });
    const res = await handleHttp(
      req("http://s3.amazonaws.com/cap/aws-creds", { Authorization: "boot_secret" }),
      ctx,
      deps,
    );
    expect(res.kind).toBe("respond");
    if (res.kind !== "respond") return;
    expect(res.res.status).toBe(200);
    const body = JSON.parse(res.res.body);
    expect(body.AccessKeyId).toBe("AKIATEST");
    expect(body.SecretAccessKey).toBe("secret_xyz");
  });

  it("routes to metadata-gcp mode for gcp_metadata_v1 protocol", async () => {
    const deps = baseDeps();
    deps.resolver.set(
      { principal: "p1", cli_id: "gcloud", hostname: "metadata.google.internal" },
      { token: "ya29.tok_gcp", expires_at: Date.UTC(2026, 4, 9, 13, 0, 0) },
    );
    deps.clock.set(Date.UTC(2026, 4, 9, 12, 0, 0));
    const res = await handleHttp(
      req(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { "Metadata-Flavor": "Google" },
      ),
      ctx,
      deps,
    );
    expect(res.kind).toBe("respond");
    if (res.kind !== "respond") return;
    expect(res.res.status).toBe(200);
    const body = JSON.parse(res.res.body);
    expect(body.access_token).toBe("ya29.tok_gcp");
    expect(body.expires_in).toBe(3600);
  });

  it("passes the resolver result through (null when no creds configured → header mode passthrough)", async () => {
    const deps = baseDeps();
    // No resolver.set — resolver returns null
    const res = await handleHttp(req("https://api.github.com/user"), ctx, deps);
    expect(res).toEqual({ kind: "passthrough" });
  });

  it("passes principal, cli_id, and lowercase hostname to the resolver", async () => {
    const deps = baseDeps();
    await handleHttp(req("https://API.GitHub.COM/user"), ctx, deps);
    expect(deps.resolver.calls).toHaveLength(1);
    expect(deps.resolver.calls[0]).toEqual({
      op: "resolve",
      input: { principal: "p1", cli_id: "gh", hostname: "api.github.com" },
    });
  });

  it("passthrough when the matched spec is exec_helper (handleHttp is not the right entry point)", async () => {
    const deps = baseDeps();
    const res = await handleHttp(req("https://never-reached.example.com/x"), ctx, deps);
    expect(res).toEqual({ kind: "passthrough" });
    // Resolver must NOT be called for exec_helper specs over HTTP — the
    // CLI never actually reaches this hostname (helper is invoked by the
    // CLI as a subprocess), so any traffic claiming to is suspicious.
    expect(deps.resolver.calls).toHaveLength(0);
  });
});

describe("handleHttp — error handling", () => {
  it("wraps a thrown resolver in ResolverError", async () => {
    const deps = baseDeps();
    deps.resolver.throwOn = { kind: "resolve", error: new Error("kv timeout") };
    await expect(handleHttp(req("https://api.github.com/user"), ctx, deps)).rejects.toBeInstanceOf(
      ResolverError,
    );
  });

  it("ResolverError preserves the original cause", async () => {
    const deps = baseDeps();
    const original = new Error("kv timeout");
    deps.resolver.throwOn = { kind: "resolve", error: original };
    try {
      await handleHttp(req("https://api.github.com/user"), ctx, deps);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolverError);
      expect((err as ResolverError).cause).toBe(original);
    }
  });
});

describe("handleHttp — URL parsing", () => {
  it("treats malformed URLs as passthrough rather than throwing", async () => {
    const deps = baseDeps();
    const res = await handleHttp(req("not a url"), ctx, deps);
    expect(res).toEqual({ kind: "passthrough" });
  });

  it("strips the port from the hostname when matching", async () => {
    // Some sandboxes' libcurl includes the port in the URL even for
    // standard https. Hostname should ignore the port for matching.
    const deps = baseDeps();
    deps.resolver.set({ principal: "p1", cli_id: "gh", hostname: "api.github.com" }, {
      token: "tok_gh",
    });
    const res = await handleHttp(req("https://api.github.com:443/user"), ctx, deps);
    expect(res.kind).toBe("forward");
    if (res.kind !== "forward") return;
    expect(res.req.headers["Authorization"]).toBe("Bearer tok_gh");
  });
});
