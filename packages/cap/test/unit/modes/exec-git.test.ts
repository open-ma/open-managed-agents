import { describe, it, expect } from "vitest";
import { applyGitExec } from "../../../src/modes/exec-git";
import { MalformedHelperInputError } from "../../../src/errors";

const stdinFor = (protocol: string, host: string, extra: Record<string, string> = {}) => {
  const parts = [`protocol=${protocol}`, `host=${host}`];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${v}`);
  return parts.join("\n") + "\n\n";
};

describe("applyGitExec — get subcommand", () => {
  it("token present → key=value stanza terminated by blank line", () => {
    const out = applyGitExec(
      "git",
      { token: "ghp_xxx" },
      { args: ["get"], stdin: stdinFor("https", "github.com") },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe(
      "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_xxx\n\n",
    );
  });

  it("uses extras.username when supplied (registry-specific username)", () => {
    const out = applyGitExec(
      "git",
      { token: "tok", extras: { username: "oauth2" } },
      { args: ["get"], stdin: stdinFor("https", "gitlab.com") },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text).toContain("username=oauth2\n");
    expect(out.text).toContain("password=tok\n");
  });

  it("preserves the protocol and host from the input", () => {
    const out = applyGitExec(
      "git",
      { token: "tok" },
      { args: ["get"], stdin: stdinFor("https", "ghe.example.com") },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text).toContain("protocol=https\n");
    expect(out.text).toContain("host=ghe.example.com\n");
  });

  it("token null → empty stdout (git falls back to next helper or prompt)", () => {
    const out = applyGitExec(
      "git",
      null,
      { args: ["get"], stdin: stdinFor("https", "github.com") },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("");
    expect(out.exit).toBe(0);
  });

  it("output ends with a blank line (the protocol terminator)", () => {
    const out = applyGitExec(
      "git",
      { token: "ghp_x" },
      { args: ["get"], stdin: stdinFor("https", "github.com") },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    expect(out.text.endsWith("\n\n")).toBe(true);
  });
});

describe("applyGitExec — input parsing", () => {
  it("ignores trailing whitespace lines after the blank-line terminator", () => {
    const out = applyGitExec(
      "git",
      { token: "tok" },
      { args: ["get"], stdin: "protocol=https\nhost=github.com\n\n  \n  " },
    );
    expect(out.kind).toBe("stdout");
  });

  it("ignores extra key=value pairs we don't care about (path, username supplied by git, etc.)", () => {
    const out = applyGitExec(
      "git",
      { token: "ghp_x" },
      {
        args: ["get"],
        stdin: stdinFor("https", "github.com", { path: "owner/repo", username: "git-supplied" }),
      },
    );
    if (out.kind !== "stdout") throw new Error("expected stdout");
    // Our username overrides any git-supplied one.
    expect(out.text).toContain("username=x-access-token\n");
  });

  it("missing protocol → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec(
        "git",
        { token: "tok" },
        { args: ["get"], stdin: "host=github.com\n\n" },
      ),
    ).toThrow(MalformedHelperInputError);
  });

  it("missing host → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec(
        "git",
        { token: "tok" },
        { args: ["get"], stdin: "protocol=https\n\n" },
      ),
    ).toThrow(MalformedHelperInputError);
  });

  it("missing terminating blank line → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec(
        "git",
        { token: "tok" },
        { args: ["get"], stdin: "protocol=https\nhost=github.com\n" },
      ),
    ).toThrow(MalformedHelperInputError);
  });

  it("no stdin field → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec("git", { token: "tok" }, { args: ["get"] }),
    ).toThrow(MalformedHelperInputError);
  });
});

describe("applyGitExec — store / erase", () => {
  it("store is a no-op (vault is the source of truth, git can't write to it via this side channel)", () => {
    const out = applyGitExec(
      "git",
      null,
      {
        args: ["store"],
        stdin: stdinFor("https", "github.com", { username: "u", password: "p" }),
      },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("");
    expect(out.exit).toBe(0);
  });

  it("erase is a no-op", () => {
    const out = applyGitExec(
      "git",
      null,
      { args: ["erase"], stdin: stdinFor("https", "github.com") },
    );
    expect(out.kind).toBe("stdout");
    if (out.kind !== "stdout") return;
    expect(out.text).toBe("");
    expect(out.exit).toBe(0);
  });
});

describe("applyGitExec — invalid subcommand", () => {
  it("missing args → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec("git", { token: "tok" }, { stdin: stdinFor("https", "github.com") }),
    ).toThrow(MalformedHelperInputError);
  });

  it("unknown subcommand → MalformedHelperInputError", () => {
    expect(() =>
      applyGitExec(
        "git",
        { token: "tok" },
        { args: ["explode"], stdin: stdinFor("https", "github.com") },
      ),
    ).toThrow(MalformedHelperInputError);
  });
});
