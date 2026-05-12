import { describe, it, expect } from "vitest";
import { handleExec } from "../../src/handle-exec";
import { createSpecRegistry } from "../../src/registry";
import { FakeResolver, ManualClock, SilentLogger } from "../../src/test-fakes";
import { ResolverError, UnknownCliError } from "../../src/errors";
import type { CapSpec } from "../../src/types";

const kubectlSpec: CapSpec = {
  cli_id: "kubectl",
  description: "kubectl auth helper",
  endpoints: ["*.kube.example.com"],
  inject_mode: "exec_helper",
  exec: { protocol: "kubectl_exec_credential_v1" },
};

const dockerSpec: CapSpec = {
  cli_id: "docker",
  description: "docker registry auth",
  endpoints: ["index.docker.io"],
  inject_mode: "exec_helper",
  exec: { protocol: "docker_credential_helper" },
};

const gitSpec: CapSpec = {
  cli_id: "git",
  description: "git credential helper",
  endpoints: ["github.com"],
  inject_mode: "exec_helper",
  exec: { protocol: "git_credential_helper" },
};

const ghSpec: CapSpec = {
  cli_id: "gh",
  description: "GitHub CLI",
  endpoints: ["api.github.com"],
  inject_mode: "header",
  header: { strip: ["authorization"], set: { name: "Authorization", value: "Bearer ${token}" } },
};

const baseDeps = () => ({
  resolver: new FakeResolver(),
  registry: createSpecRegistry([kubectlSpec, dockerSpec, gitSpec, ghSpec]),
  clock: new ManualClock(0),
  logger: new SilentLogger(),
});

const ctx = (hostname?: string) => ({ principal: "p1", hostname });

describe("handleExec — routing", () => {
  it("routes to kubectl exec mode for kubectl_exec_credential_v1 protocol", async () => {
    const deps = baseDeps();
    deps.resolver.set(
      { principal: "p1", cli_id: "kubectl", hostname: "api.kube.example.com" },
      { token: "tok_kube", expires_at: Date.UTC(2026, 4, 9, 13, 0, 0) },
    );
    const res = await handleExec("kubectl", ctx("api.kube.example.com"), {}, deps);
    expect(res.kind).toBe("stdout");
    if (res.kind !== "stdout") return;
    const cred = JSON.parse(res.text);
    expect(cred.apiVersion).toBe("client.authentication.k8s.io/v1");
    expect(cred.status.token).toBe("tok_kube");
  });

  it("routes to docker exec mode for docker_credential_helper protocol", async () => {
    const deps = baseDeps();
    deps.resolver.set(
      { principal: "p1", cli_id: "docker", hostname: "index.docker.io" },
      { token: "tok_docker" },
    );
    const res = await handleExec(
      "docker",
      ctx("index.docker.io"),
      { stdin: "https://index.docker.io/v1/", args: ["get"] },
      deps,
    );
    expect(res.kind).toBe("stdout");
    if (res.kind !== "stdout") return;
    const body = JSON.parse(res.text);
    expect(body.Secret).toBe("tok_docker");
  });

  it("routes to git exec mode for git_credential_helper protocol", async () => {
    const deps = baseDeps();
    deps.resolver.set(
      { principal: "p1", cli_id: "git", hostname: "github.com" },
      { token: "tok_git" },
    );
    const res = await handleExec(
      "git",
      ctx("github.com"),
      { stdin: "protocol=https\nhost=github.com\n\n", args: ["get"] },
      deps,
    );
    expect(res.kind).toBe("stdout");
    if (res.kind !== "stdout") return;
    expect(res.text).toContain("password=tok_git\n");
  });
});

describe("handleExec — resolver invocation", () => {
  it("uses ctx.hostname as the resolver hostname when supplied", async () => {
    const deps = baseDeps();
    await handleExec("kubectl", ctx("prod.kube.example.com"), {}, deps);
    expect(deps.resolver.calls).toHaveLength(1);
    expect(deps.resolver.calls[0]!.input).toEqual({
      principal: "p1",
      cli_id: "kubectl",
      hostname: "prod.kube.example.com",
    });
  });

  it("uses cli_id as fallback hostname when ctx.hostname is omitted", async () => {
    // For exec_helper CLIs the hostname concept is sometimes meaningless
    // (kubectl invokes the helper without knowing which cluster it's
    // talking to in some configs). Fall back to cli_id so the resolver
    // still receives a stable, principal-scoped identifier.
    const deps = baseDeps();
    await handleExec("kubectl", { principal: "p1" }, {}, deps);
    expect(deps.resolver.calls[0]!.input.hostname).toBe("kubectl");
  });

  it("returns null-token result when resolver returns null (kubectl mode emits error exit=1)", async () => {
    // No resolver.set
    const deps = baseDeps();
    const res = await handleExec("kubectl", ctx("api.kube.example.com"), {}, deps);
    expect(res.kind).toBe("error");
    if (res.kind !== "error") return;
    expect(res.exit).toBe(1);
  });
});

describe("handleExec — errors", () => {
  it("throws UnknownCliError when cli_id has no spec", async () => {
    const deps = baseDeps();
    await expect(handleExec("nope", ctx("foo"), {}, deps)).rejects.toBeInstanceOf(
      UnknownCliError,
    );
  });

  it("throws UnknownCliError when cli_id maps to a non-exec_helper spec", async () => {
    // gh is registered as header_inject — handleExec must not invoke it.
    const deps = baseDeps();
    await expect(
      handleExec("gh", ctx("api.github.com"), {}, deps),
    ).rejects.toBeInstanceOf(UnknownCliError);
  });

  it("wraps a thrown resolver in ResolverError", async () => {
    const deps = baseDeps();
    deps.resolver.throwOn = { kind: "resolve", error: new Error("kv timeout") };
    await expect(
      handleExec("kubectl", ctx("api.kube.example.com"), {}, deps),
    ).rejects.toBeInstanceOf(ResolverError);
  });
});
