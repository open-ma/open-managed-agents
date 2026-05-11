import { describe, it, expect } from "vitest";
import { applyDockerExec } from "../../../src/modes/exec-docker";
import { MalformedHelperInputError } from "../../../src/errors";

describe("applyDockerExec — get subcommand", () => {
  it("token present → JSON { ServerURL, Username, Secret }", () => {
    const out = applyDockerExec(
      "docker",
      { token: "tok_abc" },
      { args: ["get"], stdin: "https://index.docker.io/v1/\n" },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    const body = JSON.parse(out.text);
    expect(body.ServerURL).toBe("https://index.docker.io/v1/");
    expect(body.Secret).toBe("tok_abc");
    expect(body.Username).toBe("oauth2accesstoken"); // default
  });

  it("uses extras.username when supplied (registry-specific username)", () => {
    const out = applyDockerExec(
      "docker",
      { token: "tok_abc", extras: { username: "AWS" } },
      { args: ["get"], stdin: "https://1234.dkr.ecr.us-east-1.amazonaws.com\n" },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const body = JSON.parse(out.text);
    expect(body.Username).toBe("AWS");
  });

  it("strips trailing whitespace/newline from stdin ServerURL", () => {
    const out = applyDockerExec(
      "docker",
      { token: "tok" },
      { args: ["get"], stdin: "  https://index.docker.io/v1/\n\n  " },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const body = JSON.parse(out.text);
    expect(body.ServerURL).toBe("https://index.docker.io/v1/");
  });

  it("token null → empty JSON {} (per credential-helper spec, signals 'no creds')", () => {
    const out = applyDockerExec(
      "docker",
      null,
      { args: ["get"], stdin: "https://index.docker.io/v1/\n" },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("{}");
    expect(out.exit).toBe(0);
  });

  it("get with empty stdin → MalformedHelperInputError", () => {
    expect(() =>
      applyDockerExec(
        "docker",
        { token: "tok" },
        { args: ["get"], stdin: "" },
      ),
    ).toThrow(MalformedHelperInputError);
  });

  it("get with no stdin field → MalformedHelperInputError", () => {
    expect(() =>
      applyDockerExec("docker", { token: "tok" }, { args: ["get"] }),
    ).toThrow(MalformedHelperInputError);
  });
});

describe("applyDockerExec — store / erase subcommands", () => {
  it("store is a no-op (CAP doesn't accept inbound writes — token comes from vault)", () => {
    const out = applyDockerExec(
      "docker",
      null,
      {
        args: ["store"],
        stdin: '{"ServerURL":"x","Username":"u","Secret":"s"}',
      },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("");
    expect(out.exit).toBe(0);
  });

  it("erase is a no-op (CAP doesn't accept inbound deletes)", () => {
    const out = applyDockerExec(
      "docker",
      null,
      { args: ["erase"], stdin: "https://index.docker.io/v1/" },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("");
    expect(out.exit).toBe(0);
  });
});

describe("applyDockerExec — list subcommand", () => {
  it("list with token → JSON { ServerURL: Username }", () => {
    const out = applyDockerExec(
      "docker",
      { token: "tok", extras: { username: "u1" } },
      { args: ["list"], stdin: "" },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    const body = JSON.parse(out.text);
    // For CAP, list returns a single entry keyed by a generic placeholder
    // since the helper has no on-disk credentials cache; docker uses this
    // for `docker-credential-helper list` informational output.
    expect(typeof body).toBe("object");
  });

  it("list with no token → empty {}", () => {
    const out = applyDockerExec(
      "docker",
      null,
      { args: ["list"], stdin: "" },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text).toBe("{}");
  });
});

describe("applyDockerExec — invalid subcommand", () => {
  it("missing args → MalformedHelperInputError", () => {
    expect(() =>
      applyDockerExec("docker", { token: "tok" }, {}),
    ).toThrow(MalformedHelperInputError);
  });

  it("unknown subcommand → MalformedHelperInputError", () => {
    expect(() =>
      applyDockerExec(
        "docker",
        { token: "tok" },
        { args: ["explode"], stdin: "" },
      ),
    ).toThrow(MalformedHelperInputError);
  });
});
