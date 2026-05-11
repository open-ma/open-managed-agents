import { describe, expect, it } from "vitest";
import { handleExec } from "../../../src/handle-exec";
import { buildDeps, setTok } from "./_helpers";

describe("docker — credential helper", () => {
  it("get → JSON {ServerURL, Username, Secret}", async () => {
    const deps = buildDeps();
    setTok(deps.resolver, "docker", "index.docker.io", "tok_docker");
    const res = await handleExec(
      "docker",
      { principal: "p1", hostname: "index.docker.io" },
      { args: ["get"], stdin: "https://index.docker.io/v1/\n" },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    const body = JSON.parse(res.text);
    expect(body.ServerURL).toBe("https://index.docker.io/v1/");
    expect(body.Secret).toBe("tok_docker");
    expect(body.Username).toBe("oauth2accesstoken");
  });

  it("get with no token → empty {} (lets docker prompt the user)", async () => {
    const deps = buildDeps();
    const res = await handleExec(
      "docker",
      { principal: "p1", hostname: "index.docker.io" },
      { args: ["get"], stdin: "https://index.docker.io/v1/\n" },
      deps,
    );
    if (res.kind !== "stdout") throw new Error("expected stdout");
    expect(res.text).toBe("{}");
  });

  it("store / erase are no-ops (vault is the authoritative store)", async () => {
    const deps = buildDeps();
    const store = await handleExec(
      "docker",
      { principal: "p1", hostname: "index.docker.io" },
      { args: ["store"], stdin: '{"ServerURL":"x","Username":"u","Secret":"s"}' },
      deps,
    );
    if (store.kind !== "stdout") throw new Error("expected stdout");
    expect(store.text).toBe("");

    const erase = await handleExec(
      "docker",
      { principal: "p1", hostname: "index.docker.io" },
      { args: ["erase"], stdin: "https://index.docker.io/v1/" },
      deps,
    );
    if (erase.kind !== "stdout") throw new Error("expected stdout");
    expect(erase.text).toBe("");
  });
});
