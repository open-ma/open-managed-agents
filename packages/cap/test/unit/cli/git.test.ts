import { describe, expect, it } from "vitest";
import { handleExec } from "../../../src/handle-exec";
import { buildDeps, setTok } from "./_helpers";

describe("git — credential helper", () => {
  it("get → key=value stanza with username + password", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "git", "github.com", "ghp_xxx");
    const res = await handleExec(
      "git",
      { principal: "p1", hostname: "github.com" },
      { args: ["get"], stdin: "protocol=https\nhost=github.com\n\n" },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    expect(res.text).toBe(
      "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_xxx\n\n",
    );
  });

  it("get with no token → empty stdout (git falls back / prompts)", async () => {
    const deps = buildDeps();
    const res = await handleExec(
      "git",
      { principal: "p1", hostname: "github.com" },
      { args: ["get"], stdin: "protocol=https\nhost=github.com\n\n" },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    expect(res.text).toBe("");
  });

  it("respects custom username via extras (e.g. for GitLab convention)", async () => {
    const deps = buildDeps();
    deps.resolver.set(
      { principal: "p1", cli_id: "git", hostname: "github.com" },
      { token: "tok", extras: { username: "oauth2" } },
    );
    const res = await handleExec(
      "git",
      { principal: "p1", hostname: "github.com" },
      { args: ["get"], stdin: "protocol=https\nhost=github.com\n\n" },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    expect(res.text).toContain("username=oauth2\n");
  });

  it("store / erase are no-ops", async () => {
    const deps = buildDeps();
    const store = await handleExec(
      "git",
      { principal: "p1", hostname: "github.com" },
      { args: ["store"], stdin: "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n" },
      deps,
    );
    if (store.kind !== "stdout") throw new Error("expected stdout");
    expect(store.text).toBe("");
  });
});
